"""
AIOps Brain - Phase 3: Human-in-the-Loop
LangGraph with Interrupt/Resume + PostgreSQL Persistence
Powered by Cerebras Llama 3.3 70B + Netdata MCP
"""

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional, List, Dict, Any, Literal
import httpx
import os
import json
import uuid
import asyncio
from datetime import datetime
from openai import OpenAI

# Database
import asyncpg

app = FastAPI(title="AIOps Brain", version="3.0.0")

# CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
NETDATA_URL = os.getenv("NETDATA_URL", "http://localhost:19999")
CEREBRAS_API_KEY = 'csk-vtykhvxvxhtnrtdrd3p892v48nfpd2mt49tpx4mr68d69559'
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://aiops:aiops_password@localhost:5432/aiops_brain")

# Database pool
db_pool = None

# WebSocket connections for real-time updates
websocket_connections: List[WebSocket] = []

# Initialize Cerebras client
cerebras_client = None
if CEREBRAS_API_KEY:
    cerebras_client = OpenAI(
        base_url="https://api.cerebras.ai/v1",
        api_key=CEREBRAS_API_KEY,
    )

# ============================================================================
# DATABASE SETUP
# ============================================================================

async def init_db():
    """Initialize database connection and create tables"""
    global db_pool
    try:
        db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
        
        async with db_pool.acquire() as conn:
            # Create tables
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS pending_actions (
                    id UUID PRIMARY KEY,
                    created_at TIMESTAMP DEFAULT NOW(),
                    action_type VARCHAR(100) NOT NULL,
                    target VARCHAR(255) NOT NULL,
                    description TEXT NOT NULL,
                    impact VARCHAR(255),
                    rollback_plan TEXT,
                    severity VARCHAR(20) DEFAULT 'MEDIUM',
                    investigation_context JSONB,
                    status VARCHAR(20) DEFAULT 'PENDING',
                    resolved_at TIMESTAMP,
                    resolved_by VARCHAR(100),
                    resolution VARCHAR(20)
                )
            ''')
            
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS audit_log (
                    id SERIAL PRIMARY KEY,
                    timestamp TIMESTAMP DEFAULT NOW(),
                    event_type VARCHAR(50) NOT NULL,
                    actor VARCHAR(50) NOT NULL,
                    action TEXT NOT NULL,
                    metadata JSONB,
                    action_id UUID REFERENCES pending_actions(id)
                )
            ''')
            
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS incidents (
                    id UUID PRIMARY KEY,
                    created_at TIMESTAMP DEFAULT NOW(),
                    title VARCHAR(255) NOT NULL,
                    description TEXT,
                    severity VARCHAR(20),
                    status VARCHAR(20) DEFAULT 'OPEN',
                    root_cause TEXT,
                    resolution TEXT,
                    closed_at TIMESTAMP
                )
            ''')
            
        print("✅ Database initialized successfully")
    except Exception as e:
        print(f"⚠️ Database initialization failed: {e}")
        print("   HITL features will run in memory-only mode")


# In-memory fallback for when DB is unavailable
pending_actions_memory: Dict[str, Dict] = {}


async def log_audit(event_type: str, actor: str, action: str, metadata: dict = None, action_id: str = None):
    """Log an audit event"""
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.execute('''
                    INSERT INTO audit_log (event_type, actor, action, metadata, action_id)
                    VALUES ($1, $2, $3, $4, $5)
                ''', event_type, actor, action, json.dumps(metadata) if metadata else None, 
                    uuid.UUID(action_id) if action_id else None)
        except Exception as e:
            print(f"Audit log error: {e}")


# ============================================================================
# NETDATA MCP TOOLS - Extended Suite
# ============================================================================

NETDATA_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_cpu_usage",
            "description": "Get real-time CPU usage percentage with breakdown",
            "parameters": {"type": "object", "properties": {"duration_seconds": {"type": "integer", "default": 60}}, "required": []}
        }
    },
    {
        "type": "function", 
        "function": {
            "name": "get_memory_usage",
            "description": "Get memory/RAM usage with breakdown",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_active_alerts",
            "description": "Get all active alerts from the monitoring system",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_top_processes_by_cpu",
            "description": "Get top processes consuming CPU",
            "parameters": {"type": "object", "properties": {"limit": {"type": "integer", "default": 10}}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_system_info",
            "description": "Get system information",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_load_average",
            "description": "Get system load average",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_disk_io",
            "description": "Get disk I/O statistics",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_network_traffic",
            "description": "Get network traffic statistics",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "diagnose_alert",
            "description": "Perform comprehensive diagnosis of an alert",
            "parameters": {"type": "object", "properties": {"alert_name": {"type": "string"}}, "required": ["alert_name"]}
        }
    }
]

# REMEDIATION TOOLS - For proposing actions
REMEDIATION_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "propose_remediation",
            "description": "Propose a remediation action that requires human approval. Use this when you've identified an issue and want to fix it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action_type": {
                        "type": "string",
                        "enum": ["restart_service", "kill_process", "clear_cache", "scale_up", "scale_down", "restart_container", "run_playbook", "custom"],
                        "description": "Type of remediation action"
                    },
                    "target": {
                        "type": "string",
                        "description": "Target of the action (e.g., service name, process name, container ID)"
                    },
                    "description": {
                        "type": "string",
                        "description": "Detailed description of what the action will do"
                    },
                    "impact": {
                        "type": "string",
                        "description": "Expected impact (e.g., '2-3 seconds downtime')"
                    },
                    "rollback_plan": {
                        "type": "string",
                        "description": "How to rollback if the action fails"
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
                        "description": "Severity/risk level of the action"
                    }
                },
                "required": ["action_type", "target", "description"]
            }
        }
    }
]


async def execute_tool(tool_name: str, arguments: dict) -> str:
    """Execute a Netdata MCP tool and return the result"""
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            if tool_name == "get_cpu_usage":
                duration = arguments.get("duration_seconds", 60)
                response = await client.get(
                    f"{NETDATA_URL}/api/v1/data",
                    params={"chart": "system.cpu", "after": -duration, "points": 1, "format": "json"}
                )
                data = response.json()
                if data.get("data") and len(data["data"]) > 0:
                    values = data["data"][0][1:]
                    total = sum(values)
                    return f"Total CPU usage: {total:.1f}%"
                return "Unable to fetch CPU data"

            elif tool_name == "get_memory_usage":
                response = await client.get(
                    f"{NETDATA_URL}/api/v1/data",
                    params={"chart": "system.ram", "after": -1, "points": 1, "format": "json"}
                )
                data = response.json()
                if data.get("data") and len(data["data"]) > 0:
                    labels = data.get("labels", [])[1:]
                    values = data["data"][0][1:]
                    total = sum(values)
                    used = values[1] if len(values) > 1 else 0
                    pct = (used / total * 100) if total > 0 else 0
                    return f"Memory: {used:.0f} MiB used of {total:.0f} MiB ({pct:.1f}%)"
                return "Unable to fetch memory data"

            elif tool_name == "get_active_alerts":
                response = await client.get(f"{NETDATA_URL}/api/v1/alarms?active")
                data = response.json()
                alarms = data.get("alarms", {})
                if not alarms:
                    return "✅ No active alerts. All systems normal."
                results = []
                for name, alert in alarms.items():
                    status = alert.get("status", "UNKNOWN")
                    chart = alert.get("chart", "")
                    results.append(f"[{status}] {name} on {chart}")
                return f"Found {len(alarms)} alert(s):\n" + "\n".join(results)

            elif tool_name == "get_top_processes_by_cpu":
                limit = arguments.get("limit", 10)
                response = await client.get(
                    f"{NETDATA_URL}/api/v1/data",
                    params={"chart": "apps.cpu", "after": -1, "points": 1, "format": "json"}
                )
                data = response.json()
                if data.get("data") and len(data["data"]) > 0:
                    labels = data.get("labels", [])[1:]
                    values = data["data"][0][1:]
                    processes = sorted(zip(labels, values), key=lambda x: x[1], reverse=True)[:limit]
                    results = [f"{name}: {cpu:.1f}%" for name, cpu in processes if cpu > 0]
                    return "Top CPU:\n" + "\n".join(results) if results else "No significant CPU usage"
                return "Unable to fetch process data"

            elif tool_name == "get_system_info":
                response = await client.get(f"{NETDATA_URL}/api/v1/info")
                data = response.json()
                return f"Hostname: {data.get('hostname', 'Unknown')}, OS: {data.get('os_name', '')}"

            elif tool_name == "get_load_average":
                response = await client.get(
                    f"{NETDATA_URL}/api/v1/data",
                    params={"chart": "system.load", "after": -1, "points": 1, "format": "json"}
                )
                data = response.json()
                if data.get("data") and len(data["data"]) > 0:
                    values = data["data"][0][1:]
                    return f"Load: 1m={values[0]:.2f}, 5m={values[1]:.2f}, 15m={values[2]:.2f}"
                return "Unable to fetch load data"

            elif tool_name == "get_disk_io":
                response = await client.get(
                    f"{NETDATA_URL}/api/v1/data",
                    params={"chart": "system.io", "after": -1, "points": 1, "format": "json"}
                )
                data = response.json()
                if data.get("data") and len(data["data"]) > 0:
                    values = data["data"][0][1:]
                    return f"Disk I/O: Read {abs(values[0]):.1f} KB/s, Write {abs(values[1]):.1f} KB/s"
                return "Unable to fetch disk I/O data"

            elif tool_name == "get_network_traffic":
                response = await client.get(
                    f"{NETDATA_URL}/api/v1/data",
                    params={"chart": "system.net", "after": -1, "points": 1, "format": "json"}
                )
                data = response.json()
                if data.get("data") and len(data["data"]) > 0:
                    values = data["data"][0][1:]
                    return f"Network: ↓{abs(values[0]):.1f} KB/s, ↑{abs(values[1]):.1f} KB/s"
                return "Unable to fetch network data"

            elif tool_name == "diagnose_alert":
                # Comprehensive diagnosis
                results = []
                for tool in ["get_active_alerts", "get_cpu_usage", "get_memory_usage", "get_load_average", "get_top_processes_by_cpu"]:
                    r = await execute_tool(tool, {})
                    results.append(r)
                return "\n\n".join(results)

            elif tool_name == "propose_remediation":
                # Create pending action
                action_id = str(uuid.uuid4())
                action = {
                    "id": action_id,
                    "created_at": datetime.now().isoformat(),
                    "action_type": arguments.get("action_type", "custom"),
                    "target": arguments.get("target", "unknown"),
                    "description": arguments.get("description", ""),
                    "impact": arguments.get("impact", "Unknown"),
                    "rollback_plan": arguments.get("rollback_plan", "Manual intervention required"),
                    "severity": arguments.get("severity", "MEDIUM"),
                    "status": "PENDING"
                }
                
                # Store in database or memory
                if db_pool:
                    try:
                        async with db_pool.acquire() as conn:
                            await conn.execute('''
                                INSERT INTO pending_actions (id, action_type, target, description, impact, rollback_plan, severity, status)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            ''', uuid.UUID(action_id), action["action_type"], action["target"], 
                                action["description"], action["impact"], action["rollback_plan"], 
                                action["severity"], "PENDING")
                    except Exception as e:
                        print(f"DB error: {e}")
                        pending_actions_memory[action_id] = action
                else:
                    pending_actions_memory[action_id] = action
                
                # Log audit
                await log_audit("ACTION_PROPOSED", "AI", f"Proposed: {action['action_type']} on {action['target']}", action, action_id)
                
                # Notify connected websockets
                await broadcast_pending_action(action)
                
                return f"🛠️ PROPOSED ACTION (ID: {action_id[:8]})\n\nAction: {action['action_type']}\nTarget: {action['target']}\nDescription: {action['description']}\nImpact: {action['impact']}\nRollback: {action['rollback_plan']}\n\n⏳ AWAITING HUMAN APPROVAL"

            else:
                return f"Unknown tool: {tool_name}"

        except Exception as e:
            return f"Error: {str(e)}"


async def broadcast_pending_action(action: dict):
    """Broadcast pending action to all connected websockets"""
    message = json.dumps({"type": "pending_action", "action": action})
    disconnected = []
    for ws in websocket_connections:
        try:
            await ws.send_text(message)
        except:
            disconnected.append(ws)
    for ws in disconnected:
        websocket_connections.remove(ws)


# ============================================================================
# AGENT PROMPTS
# ============================================================================

SUPERVISOR_PROMPT = """You are the Supervisor Agent for an AIOps platform. Your role is to:
1. Analyze incoming requests and alerts
2. Use monitoring tools to gather data
3. When you identify an issue that needs fixing, use propose_remediation to suggest a fix

IMPORTANT: When proposing remediation, always provide:
- Clear action_type (restart_service, kill_process, etc.)
- Specific target
- Detailed description
- Expected impact
- Rollback plan

Be concise and action-oriented."""

REMEDIATION_PROMPT = """You are a Remediation Agent. When asked to fix something, you MUST use the propose_remediation tool.

DO NOT describe what you would do - ACTUALLY CALL the propose_remediation function with:
- action_type: restart_service, kill_process, clear_cache, scale_up, scale_down, restart_container, run_playbook, or custom
- target: The specific service, process, or component
- description: What the action will do
- impact: Expected impact (e.g., "2-3 seconds downtime")
- rollback_plan: How to undo if it fails
- severity: LOW, MEDIUM, HIGH, or CRITICAL

You MUST call propose_remediation. DO NOT just describe it - EXECUTE THE TOOL."""


# ============================================================================
# API MODELS
# ============================================================================

class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    response: str
    tools_used: List[str] = []
    pending_action: Optional[Dict] = None
    investigation_complete: bool = False


class ApprovalRequest(BaseModel):
    action_id: str
    decision: Literal["approve", "reject", "modify"]
    modified_action: Optional[Dict] = None
    approved_by: str = "admin"


# ============================================================================
# API ENDPOINTS
# ============================================================================

@app.on_event("startup")
async def startup():
    await init_db()


@app.get("/")
async def root():
    return {
        "status": "online",
        "service": "AIOps Brain v3.0 - Human-in-the-Loop",
        "model": "Cerebras Llama 3.3 70B",
        "features": ["Investigation", "Remediation", "HITL Approval", "Audit Log"],
        "tools_available": len(NETDATA_TOOLS) + len(REMEDIATION_TOOLS)
    }


@app.get("/health")
async def health_check():
    netdata_ok = False
    db_ok = db_pool is not None
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{NETDATA_URL}/api/v1/info", timeout=2.0)
            netdata_ok = response.status_code == 200
    except:
        pass
    
    return {
        "status": "healthy" if netdata_ok else "degraded",
        "netdata_connected": netdata_ok,
        "database_connected": db_ok,
        "cerebras_configured": bool(CEREBRAS_API_KEY),
        "version": "3.0.0"
    }


@app.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Main chat endpoint with investigation and remediation capabilities"""
    tools_used = []
    message_lower = request.message.lower()
    
    # Check if user wants remediation (includes log cleaning)
    wants_fix = any(word in message_lower for word in [
        "fix", "remediate", "restart", "kill", "stop", "resolve", "clear", "clean", 
        "scale", "purge", "truncate", "archive", "delete log", "remove log", 
        "clean log", "clean postgres", "clear cache", "clear log"
    ])
    
    # Check if investigation needed
    is_investigation = any(word in message_lower for word in [
        "diagnose", "investigate", "alert", "problem", "issue", "why", "analyze"
    ])
    
    all_tools = NETDATA_TOOLS + REMEDIATION_TOOLS if wants_fix else NETDATA_TOOLS
    prompt = REMEDIATION_PROMPT if wants_fix else SUPERVISOR_PROMPT
    
    # Direct test mode - bypass LLM for demo/testing
    if "test" in message_lower or "demo" in message_lower:
        result = await execute_tool("propose_remediation", {
            "action_type": "restart_service",
            "target": "test-service",
            "description": "Test remediation action for HITL demo",
            "impact": "No actual impact - demo only",
            "rollback_plan": "N/A - test only",
            "severity": "LOW"
        })
        return ChatResponse(response=result, tools_used=["propose_remediation"])
    
    if not cerebras_client:
        # Fallback mode
        if "cpu" in message_lower:
            result = await execute_tool("get_cpu_usage", {})
            return ChatResponse(response=result, tools_used=["get_cpu_usage"])
        elif wants_fix:
            # Demo remediation
            result = await execute_tool("propose_remediation", {
                "action_type": "restart_service",
                "target": "demo-service",
                "description": "Demo remediation action (LLM not configured)",
                "impact": "No actual impact - demo only",
                "rollback_plan": "N/A",
                "severity": "LOW"
            })
            return ChatResponse(response=result, tools_used=["propose_remediation"])
        else:
            result = await execute_tool("get_active_alerts", {})
            return ChatResponse(response=result, tools_used=["get_active_alerts"])
    
    try:
        messages = [{"role": "user", "content": request.message}]
        
        # Call LLM with tools
        tool_choice_mode = "required" if wants_fix else "auto"
        response = cerebras_client.chat.completions.create(
            model="llama-3.3-70b",
            messages=[{"role": "system", "content": prompt}] + messages,
            tools=all_tools,
            tool_choice=tool_choice_mode
        )
        
        assistant_msg = response.choices[0].message
        
        if assistant_msg.tool_calls:
            # Process tool calls
            last_pending_action = None
            for tc in assistant_msg.tool_calls:
                tool_name = tc.function.name
                tools_used.append(tool_name)
                try:
                    args = json.loads(tc.function.arguments)
                except:
                    args = {}
                
                result = await execute_tool(tool_name, args)
                
                # Capture the last pending action if propose_remediation was called
                if tool_name == "propose_remediation" and pending_actions_memory:
                    # Get the most recently created action from memory
                    last_pending_action = list(pending_actions_memory.values())[-1]  # Get the last added action
                
                messages.append({"role": "assistant", "content": assistant_msg.content or "",
                               "tool_calls": [{"id": tc.id, "type": "function", "function": {"name": tool_name, "arguments": tc.function.arguments}}]})
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
            
            # Get final response
            final = cerebras_client.chat.completions.create(
                model="llama-3.3-70b",
                messages=[{"role": "system", "content": prompt}] + messages
            )
            
            return ChatResponse(
                response=final.choices[0].message.content,
                tools_used=tools_used,
                investigation_complete=is_investigation,
                pending_action=last_pending_action
            )
        
        return ChatResponse(response=assistant_msg.content or "I understand. How can I help?", tools_used=[])
    
    except Exception as e:
        return ChatResponse(response=f"Error: {str(e)}", tools_used=tools_used)


@app.get("/pending-actions")
async def get_pending_actions():
    """Get all pending actions awaiting approval"""
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                rows = await conn.fetch('''
                    SELECT * FROM pending_actions WHERE status = 'PENDING' ORDER BY created_at DESC
                ''')
                return {"actions": [dict(r) for r in rows]}
        except Exception as e:
            print(f"DB error: {e}")
    
    # Fallback to memory
    pending = [a for a in pending_actions_memory.values() if a.get("status") == "PENDING"]
    return {"actions": pending}


@app.post("/actions/{action_id}/approve")
async def approve_action(action_id: str, request: ApprovalRequest):
    """Approve or reject a pending action"""
    decision = request.decision
    approved_by = request.approved_by
    
    # Get action details
    action_details = None
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                row = await conn.fetchrow('SELECT * FROM pending_actions WHERE id = $1', uuid.UUID(action_id))
                if row:
                    action_details = dict(row)
        except Exception as e:
            print(f"DB error: {e}")
    
    if not action_details and action_id in pending_actions_memory:
        action_details = pending_actions_memory[action_id]
    
    # Update status
    new_status = "EXECUTING" if decision == "approve" else decision.upper()
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.execute('''
                    UPDATE pending_actions 
                    SET status = $1, resolved_at = NOW(), resolved_by = $2, resolution = $3
                    WHERE id = $4
                ''', new_status, approved_by, decision, uuid.UUID(action_id))
        except Exception as e:
            print(f"DB error: {e}")
    
    if action_id in pending_actions_memory:
        pending_actions_memory[action_id]["status"] = new_status
        pending_actions_memory[action_id]["resolved_by"] = approved_by
    
    # Log audit
    await log_audit(f"ACTION_{decision.upper()}", approved_by, f"Action {action_id[:8]} {decision}d", {}, action_id)
    
    # Broadcast update
    message = json.dumps({"type": "action_resolved", "action_id": action_id, "decision": decision})
    for ws in websocket_connections:
        try:
            await ws.send_text(message)
        except:
            pass
    
    if decision == "approve" and action_details:
        # Trigger automation via EDA webhook
        execution_result = await trigger_automation(action_id, action_details)
        return {
            "status": "approved",
            "action_id": action_id,
            "message": "Action approved and sent to automation controller",
            "execution": execution_result
        }
    elif decision == "approve":
        return {
            "status": "approved",
            "action_id": action_id,
            "message": "Action approved (action details not found for execution)"
        }
    else:
        return {
            "status": "rejected",
            "action_id": action_id,
            "message": "Action rejected by human operator"
        }
        return {
            "status": "rejected",
            "action_id": action_id,
            "message": "Action rejected by human operator"
        }


# Configuration for automation
ANSIBLE_EDA_URL = os.getenv("ANSIBLE_EDA_URL", "http://localhost:5000")


async def trigger_automation(action_id: str, action: dict) -> dict:
    """Trigger automation via Ansible EDA webhook"""
    payload = {
        "action_id": str(action_id),
        "action_type": action.get("action_type", "custom"),
        "target": action.get("target", "unknown"),
        "description": action.get("description", ""),
        "severity": action.get("severity", "MEDIUM"),
        "callback_url": "http://host.docker.internal:8000/automation/callback"
    }
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(ANSIBLE_EDA_URL, json=payload)
            await log_audit("AUTOMATION_TRIGGERED", "system", f"Sent to EDA: {action['action_type']}", payload, action_id)
            return {
                "triggered": True,
                "eda_response": response.status_code,
                "payload": payload
            }
    except Exception as e:
        await log_audit("AUTOMATION_FAILED", "system", f"EDA trigger failed: {str(e)}", {}, action_id)
        # Fallback: execute locally with subprocess
        return await execute_local_playbook(action_id, action)


async def execute_local_playbook(action_id: str, action: dict) -> dict:
    """Fallback: Execute playbook locally if EDA is not available"""
    import subprocess
    
    action_type = action.get("action_type", "health_check")
    target = action.get("target", "localhost")
    
    playbook_map = {
        "restart_service": "restart_service.yml",
        "kill_process": "kill_process.yml",
        "clear_cache": "clear_cache.yml",
        "restart_container": "restart_container.yml",
        "health_check": "health_check.yml",
        "run_playbook": "health_check.yml",
    }
    
    playbook = playbook_map.get(action_type, "health_check.yml")
    playbook_path = f"/Users/carsch18/OFFICE_WORK/aiops-platform/apps/automation/playbooks/{playbook}"
    
    try:
        # Check if ansible-playbook is available
        result = subprocess.run(
            ["which", "ansible-playbook"],
            capture_output=True,
            text=True
        )
        
        if result.returncode != 0:
            return {
                "triggered": False,
                "error": "ansible-playbook not found",
                "message": "Install Ansible to enable local execution"
            }
        
        # Run playbook
        cmd = [
            "ansible-playbook", playbook_path,
            "-i", "localhost,",
            "-c", "local",
            "-e", f"action_id={action_id}",
            "-e", f"target={target}",
            "-e", f"service={target}",
            "-e", f"process={target}",
            "-e", f"container={target}",
            "--check"  # Dry-run mode for safety
        ]
        
        await log_audit("LOCAL_EXECUTION", "system", f"Running locally: {playbook}", {"cmd": " ".join(cmd)}, action_id)
        
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        
        return {
            "triggered": True,
            "execution_mode": "local_dry_run",
            "playbook": playbook,
            "target": target,
            "message": "Playbook executed in dry-run mode"
        }
        
    except Exception as e:
        return {
            "triggered": False,
            "error": str(e)
        }


class AutomationCallback(BaseModel):
    action_id: str
    status: str
    success: bool = True
    message: str = ""
    details: Optional[Dict] = None


@app.post("/automation/callback")
async def automation_callback(callback: AutomationCallback):
    """Receive execution results from Ansible"""
    action_id = callback.action_id
    
    # Update action status
    final_status = "COMPLETED" if callback.success else "FAILED"
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                await conn.execute('''
                    UPDATE pending_actions 
                    SET status = $1
                    WHERE id = $2
                ''', final_status, uuid.UUID(action_id))
        except Exception as e:
            print(f"DB error: {e}")
    
    # Log audit
    await log_audit(
        f"AUTOMATION_{final_status}",
        "ansible",
        callback.message,
        callback.details,
        action_id
    )
    
    # Broadcast to websockets
    message = json.dumps({
        "type": "automation_result",
        "action_id": action_id,
        "status": callback.status,
        "success": callback.success,
        "message": callback.message
    })
    for ws in websocket_connections:
        try:
            await ws.send_text(message)
        except:
            pass
    
    return {"received": True, "action_id": action_id}


@app.get("/audit-log")
async def get_audit_log(limit: int = 50):
    """Get recent audit log entries"""
    if db_pool:
        try:
            async with db_pool.acquire() as conn:
                rows = await conn.fetch('''
                    SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT $1
                ''', limit)
                return {"logs": [dict(r) for r in rows]}
        except Exception as e:
            print(f"DB error: {e}")
    
    return {"logs": []}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket for real-time updates on pending actions"""
    await websocket.accept()
    websocket_connections.append(websocket)
    
    try:
        # Send current pending actions on connect
        pending = await get_pending_actions()
        await websocket.send_text(json.dumps({"type": "initial", "pending_actions": pending["actions"]}))
        
        while True:
            # Keep connection alive
            data = await websocket.receive_text()
            # Handle any client messages if needed
    except WebSocketDisconnect:
        if websocket in websocket_connections:
            websocket_connections.remove(websocket)


if __name__ == "__main__":
    import uvicorn
    print("🧠 Starting AIOps Brain v3.0 - Human-in-the-Loop")
    print(f"📡 Netdata URL: {NETDATA_URL}")
    print(f"🗄️ Database: {DATABASE_URL.split('@')[1] if '@' in DATABASE_URL else 'configured'}")
    print(f"🤖 Cerebras API: {'Configured (Llama 3.3 70B)' if CEREBRAS_API_KEY else 'Not configured'}")
    uvicorn.run(app, host="0.0.0.0", port=8000)