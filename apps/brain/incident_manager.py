import os
import uuid
import json
import asyncio
from datetime import datetime
from typing import Dict, List, Optional
import asyncpg

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://aiops:aiops_password@localhost:5432/peekaping")

class IncidentManager:
    """
    Manages the lifecycle of incidents:
    Detection -> Logging -> Triage -> Escalation -> Resolution -> RCA
    """
    
    def __init__(self):
        self.db_pool = None
        
    async def initialize(self):
        """Initialize database pool"""
        try:
            self.db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
            await self._ensure_tables()
            print("✅ Incident Manager initialized")
        except Exception as e:
            print(f"❌ Incident Manager initialization error: {e}")
            
    async def run_migrations(self):
         """Run necessary database migrations for incidents"""
         await self._ensure_tables()

    async def _ensure_tables(self):
        """Ensure incident tables exist"""
        async with self.db_pool.acquire() as conn:
            # Upgrade incidents table if necessary
             # We need a proper schema for incidents with timeline support
            await conn.execute('''
                CREATE TABLE IF NOT EXISTS incidents (
                    id UUID PRIMARY KEY,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    title VARCHAR(255) NOT NULL,
                    description TEXT,
                    severity VARCHAR(20),
                    status VARCHAR(20) DEFAULT 'OPEN',
                    root_cause TEXT,
                    resolution TEXT,
                    closed_at TIMESTAMPTZ,
                    timeline JSONB DEFAULT '[]'::jsonb,
                    metadata JSONB DEFAULT '{}'::jsonb
                )
            ''')
            
    async def create_incident(self, title: str, description: str, severity: str, source: str = "System") -> str:
        """Create a new incident"""
        incident_id = str(uuid.uuid4())
        timeline_event = {
            "timestamp": datetime.utcnow().isoformat(),
            "event": "Incident Detected",
            "source": source,
            "details": description
        }
        
        async with self.db_pool.acquire() as conn:
            await conn.execute('''
                INSERT INTO incidents 
                (id, title, description, severity, status, timeline, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            ''', uuid.UUID(incident_id), title, description, severity, "OPEN", 
                 json.dumps([timeline_event]), json.dumps({"source": source}))
            
        print(f"🔥 INCIDENT CREATED: [{severity}] {title} (ID: {incident_id})")
        return incident_id
        
    async def update_status(self, incident_id: str, status: str, note: str = ""):
        """Update incident status"""
        valid_statuses = ["OPEN", "INVESTIGATING", "MITIGATING", "RESOLVED", "CLOSED"]
        if status not in valid_statuses:
             raise ValueError(f"Invalid status: {status}")
             
        event = {
            "timestamp": datetime.utcnow().isoformat(),
            "event": f"Status changed to {status}",
            "details": note
        }
        
        async with self.db_pool.acquire() as conn:
            # Append to timeline and update status
            await conn.execute('''
                UPDATE incidents 
                SET status = $1,
                    timeline = timeline || $2::jsonb
                WHERE id = $3
            ''', status, json.dumps([event]), uuid.UUID(str(incident_id)))
            
            if status == "CLOSED":
                await conn.execute('UPDATE incidents SET closed_at = NOW() WHERE id = $1', uuid.UUID(str(incident_id)))

    async def add_timeline_event(self, incident_id: str, event: str, details: str = ""):
        """Add a custom event to the timeline"""
        timeline_entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "event": event,
            "details": details
        }
        
        async with self.db_pool.acquire() as conn:
            await conn.execute('''
                UPDATE incidents 
                SET timeline = timeline || $1::jsonb
                WHERE id = $2
            ''', json.dumps([timeline_entry]), uuid.UUID(str(incident_id)))

    async def get_incident(self, incident_id: str) -> Dict:
        """Get incident details"""
        async with self.db_pool.acquire() as conn:
            row = await conn.fetchrow('SELECT * FROM incidents WHERE id = $1', uuid.UUID(str(incident_id)))
            if row:
                return dict(row)
            return None
            
    async def list_incidents(self, active_only: bool = True) -> List[Dict]:
        """List incidents"""
        query = 'SELECT * FROM incidents'
        if active_only:
            query += " WHERE status != 'CLOSED'"
        query += " ORDER BY created_at DESC"
        
        async with self.db_pool.acquire() as conn:
            rows = await conn.fetch(query)
            return [dict(r) for r in rows]

    async def generate_rca(self, incident_id: str) -> str:
        """Generate RCA markdown for an incident"""
        incident = await self.get_incident(incident_id)
        if not incident:
            return "Incident not found"
            
        timeline = json.loads(incident.get("timeline", "[]"))
        
        rca = f"""# Root Cause Analysis: {incident['title']}

**Date:** {datetime.utcnow().strftime('%Y-%m-%d')}
**Incident ID:** {incident_id}
**Severity:** {incident['severity']}
**Status:** {incident['status']}

## 1. Incident Summary
{incident['description']}

## 2. Timeline
"""
        for event in timeline:
            dt = datetime.fromisoformat(event['timestamp'])
            rca += f"- **{dt.strftime('%H:%M:%S UTC')}**: {event['event']} - {event.get('details', '')}\n"
            
        rca += f"""
## 3. Root Cause
{incident.get('root_cause') or "To be determined."}

## 4. Resolution
{incident.get('resolution') or "In progress."}

## 5. Corrective Actions
- [ ] Implement fix for root cause
- [ ] Add regression tests
- [ ] Update monitoring thresholds
"""
        return rca

# Global instance
incident_manager = IncidentManager()
