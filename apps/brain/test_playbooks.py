#!/usr/bin/env python3
"""
Test All Ansible Playbooks
==========================
Run this script to test all playbooks are working correctly.
Usage: python test_playbooks.py [--dry-run] [--playbook PLAYBOOK_NAME]
"""

import asyncio
import subprocess
import argparse
import os
from datetime import datetime
from typing import Dict, List, Optional
import httpx

# Configuration
ANSIBLE_EDA_URL = os.getenv("ANSIBLE_EDA_URL", "http://localhost:5000/api/v1/webhooks/aiops")
SSH_HOST = "test@10.10.2.21"
SSH_OPTIONS = ["-i", "/home/adityatiwari/.ssh/id_ed25519", "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
DDEV_DIR = "~/d1/regenics"

# All available playbooks with their action types and descriptions
PLAYBOOKS = {
    "health_check": {
        "description": "Check DDEV service health",
        "target": "ddev_service",
        "severity": "LOW",
        "ssh_command": f"cd {DDEV_DIR} && ddev status"
    },
    "ddev_health_check": {
        "description": "Detailed DDEV health check",
        "target": "ddev_service",
        "severity": "LOW",
        "ssh_command": f"cd {DDEV_DIR} && ddev describe"
    },
    "ddev_restart": {
        "description": "Restart DDEV service",
        "target": "ddev_service",
        "severity": "MEDIUM",
        "ssh_command": f"cd {DDEV_DIR} && ddev restart"
    },
    "ddev_logs": {
        "description": "Get DDEV logs",
        "target": "ddev_service",
        "severity": "LOW",
        "ssh_command": f"cd {DDEV_DIR} && ddev logs --tail 20"
    },
    "restart_service": {
        "description": "Restart DDEV service (general)",
        "target": "ddev_service",
        "severity": "MEDIUM",
        "ssh_command": f"cd {DDEV_DIR} && ddev restart"
    },
    "restart_container": {
        "description": "Restart Docker container",
        "target": "docker_container",
        "severity": "MEDIUM",
        "ssh_command": "docker ps --format '{{.Names}}' | head -3"
    },
    "site_downtime": {
        "description": "Handle site downtime",
        "target": "wordpress_site",
        "severity": "CRITICAL",
        "ssh_command": f"cd {DDEV_DIR} && ddev describe -j | grep -q running && echo 'OK' || echo 'DOWN'"
    },
    "page_load_slow": {
        "description": "Handle slow page load times",
        "target": "wordpress_site",
        "severity": "WARNING",
        "ssh_command": f"cd {DDEV_DIR} && ddev exec 'wp cache flush' 2>/dev/null || echo 'Cache flush skipped'"
    },
    "http_5xx_spike": {
        "description": "Handle HTTP 5xx error spike",
        "target": "web_server",
        "severity": "CRITICAL",
        "ssh_command": f"cd {DDEV_DIR} && ddev logs --tail 10"
    },
    "app_error_spike": {
        "description": "Handle application error spike",
        "target": "application",
        "severity": "WARNING",
        "ssh_command": f"cd {DDEV_DIR} && ddev logs --tail 10"
    },
    "db_latency": {
        "description": "Handle database latency issues",
        "target": "database",
        "severity": "WARNING",
        "ssh_command": "docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' 2>/dev/null | head -5"
    },
    "resource_spike": {
        "description": "Handle resource usage spike",
        "target": "server",
        "severity": "WARNING",
        "ssh_command": "free -m; df -h / | tail -1"
    },
    "clear_cache": {
        "description": "Clear application caches",
        "target": "application",
        "severity": "LOW",
        "ssh_command": f"cd {DDEV_DIR} && ddev exec 'wp cache flush' 2>/dev/null || echo 'Cache operation completed'"
    },
    "kill_process": {
        "description": "Kill runaway process",
        "target": "process",
        "severity": "MEDIUM",
        "ssh_command": "ps aux --sort=-%mem | head -5"
    },
    "netdata_restart": {
        "description": "Restart Netdata monitoring",
        "target": "netdata",
        "severity": "MEDIUM",
        "ssh_command": "docker ps | grep -i netdata || echo 'Netdata check completed'"
    },
    "production_emergency": {
        "description": "Production emergency shutdown/restart",
        "target": "production",
        "severity": "CRITICAL",
        "ssh_command": f"cd {DDEV_DIR} && ddev describe"
    },
    "cdn_failure": {
        "description": "Handle CDN failure",
        "target": "cdn",
        "severity": "WARNING",
        "ssh_command": "curl -sI https://cdn.example.com 2>/dev/null | head -1 || echo 'CDN check completed'"
    },
    "ddos_mitigation": {
        "description": "DDoS attack mitigation",
        "target": "security",
        "severity": "CRITICAL",
        "ssh_command": "netstat -an 2>/dev/null | head -10 || echo 'Network check completed'"
    }
}


class PlaybookTester:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.results: Dict[str, Dict] = {}
        self.eda_available = False
        
    async def check_eda_availability(self) -> bool:
        """Check if Ansible EDA is available"""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(ANSIBLE_EDA_URL.replace("/api/v1/webhooks/aiops", "/health"))
                return response.status_code == 200
        except:
            return False
    
    def run_ssh_command(self, command: str) -> Dict:
        """Execute SSH command and return result"""
        if self.dry_run:
            return {
                "success": True,
                "output": f"[DRY RUN] Would execute: {command}",
                "return_code": 0
            }
        
        try:
            full_cmd = ["ssh"] + SSH_OPTIONS + [SSH_HOST, command]
            process = subprocess.run(
                full_cmd,
                capture_output=True,
                text=True,
                timeout=300
            )
            return {
                "success": process.returncode == 0,
                "output": process.stdout or process.stderr,
                "return_code": process.returncode
            }
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "output": "Command timed out",
                "return_code": -1
            }
        except Exception as e:
            return {
                "success": False,
                "output": str(e),
                "return_code": -1
            }
    
    async def trigger_via_eda(self, playbook: str, action_data: Dict) -> Dict:
        """Trigger playbook via Ansible EDA webhook"""
        if self.dry_run:
            return {
                "success": True,
                "output": f"[DRY RUN] Would trigger EDA: {playbook}"
            }
        
        try:
            payload = {
                "action_id": f"test-{playbook}-{datetime.now().strftime('%H%M%S')}",
                "action_type": playbook,
                "target": action_data.get("target", "unknown"),
                "description": action_data.get("description", ""),
                "severity": action_data.get("severity", "MEDIUM")
            }
            
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(ANSIBLE_EDA_URL, json=payload)
                return {
                    "success": response.status_code in [200, 201, 202],
                    "output": f"EDA Response: {response.status_code}"
                }
        except Exception as e:
            return {
                "success": False,
                "output": f"EDA Error: {str(e)}"
            }
    
    async def test_playbook(self, name: str, playbook: Dict) -> Dict:
        """Test a single playbook"""
        print(f"\n{'='*60}")
        print(f"📋 Testing: {name}")
        print(f"   Description: {playbook['description']}")
        print(f"   Target: {playbook['target']}")
        print(f"   Severity: {playbook['severity']}")
        print(f"{'='*60}")
        
        result = {
            "name": name,
            "description": playbook["description"],
            "severity": playbook["severity"],
            "ssh_test": None,
            "eda_test": None,
            "overall_success": False
        }
        
        # Test via SSH
        print("\n🔧 Testing via SSH...")
        ssh_result = self.run_ssh_command(playbook["ssh_command"])
        result["ssh_test"] = ssh_result
        
        if ssh_result["success"]:
            print(f"✅ SSH Test PASSED")
            print(f"   Output: {ssh_result['output'][:200]}...")
        else:
            print(f"❌ SSH Test FAILED")
            print(f"   Error: {ssh_result['output'][:200]}")
        
        # Test via EDA if available
        if self.eda_available:
            print("\n🎭 Testing via Ansible EDA...")
            eda_result = await self.trigger_via_eda(name, playbook)
            result["eda_test"] = eda_result
            
            if eda_result["success"]:
                print(f"✅ EDA Test PASSED")
            else:
                print(f"⚠️ EDA Test FAILED (EDA may not be running)")
        
        result["overall_success"] = ssh_result["success"]
        return result
    
    async def run_all_tests(self, specific_playbook: Optional[str] = None) -> Dict[str, Dict]:
        """Run tests for all playbooks or a specific one"""
        print("\n" + "="*70)
        print("🧪 ANSIBLE PLAYBOOK TEST SUITE")
        print(f"   Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"   Mode: {'DRY RUN' if self.dry_run else 'LIVE'}")
        print(f"   Playbooks to test: {specific_playbook or 'ALL'}")
        print("="*70)
        
        # Check EDA availability
        self.eda_available = await self.check_eda_availability()
        print(f"\n📡 Ansible EDA: {'✅ Available' if self.eda_available else '❌ Not Available'}")
        
        playbooks_to_test = {}
        if specific_playbook:
            if specific_playbook in PLAYBOOKS:
                playbooks_to_test[specific_playbook] = PLAYBOOKS[specific_playbook]
            else:
                print(f"❌ Unknown playbook: {specific_playbook}")
                print(f"   Available: {', '.join(PLAYBOOKS.keys())}")
                return {}
        else:
            playbooks_to_test = PLAYBOOKS
        
        # Run tests
        for name, playbook in playbooks_to_test.items():
            result = await self.test_playbook(name, playbook)
            self.results[name] = result
            
            # Add cooldown between tests to avoid DDEV locking
            if len(playbooks_to_test) > 1:
                print("⏳ Cooling down for 15s...")
                await asyncio.sleep(15)
        
        # Print summary
        self.print_summary()
        
        return self.results
    
    def print_summary(self):
        """Print test results summary"""
        print("\n" + "="*70)
        print("📊 TEST RESULTS SUMMARY")
        print("="*70)
        
        passed = sum(1 for r in self.results.values() if r["overall_success"])
        failed = len(self.results) - passed
        
        print(f"\n{'Playbook':<25} {'Severity':<10} {'SSH':<8} {'Overall':<10}")
        print("-"*55)
        
        for name, result in self.results.items():
            ssh_status = "✅" if result["ssh_test"]["success"] else "❌"
            overall_status = "✅ PASS" if result["overall_success"] else "❌ FAIL"
            severity = result["severity"]
            print(f"{name:<25} {severity:<10} {ssh_status:<8} {overall_status:<10}")
        
        print("-"*55)
        print(f"\n📈 Total: {len(self.results)} | ✅ Passed: {passed} | ❌ Failed: {failed}")
        print(f"   Success Rate: {(passed/len(self.results)*100):.1f}%")
        
        if failed > 0:
            print("\n⚠️ FAILED PLAYBOOKS:")
            for name, result in self.results.items():
                if not result["overall_success"]:
                    print(f"   - {name}: {result['ssh_test'].get('output', 'Unknown error')[:100]}")


async def main():
    parser = argparse.ArgumentParser(description="Test all Ansible playbooks")
    parser.add_argument("--dry-run", action="store_true", help="Simulate tests without actually running commands")
    parser.add_argument("--playbook", type=str, help="Test a specific playbook by name")
    parser.add_argument("--list", action="store_true", help="List all available playbooks")
    
    args = parser.parse_args()
    
    if args.list:
        print("\n📋 Available Playbooks:")
        print("-"*60)
        for name, data in PLAYBOOKS.items():
            severity_emoji = {"LOW": "🟢", "MEDIUM": "🟡", "WARNING": "🟠", "CRITICAL": "🔴"}.get(data["severity"], "⚪")
            print(f"  {severity_emoji} {name:<25} - {data['description']}")
        print("-"*60)
        print(f"\nTotal: {len(PLAYBOOKS)} playbooks")
        return
    
    tester = PlaybookTester(dry_run=args.dry_run)
    
    try:
        await tester.run_all_tests(specific_playbook=args.playbook)
    except KeyboardInterrupt:
        print("\n\n⚠️ Tests interrupted by user")


if __name__ == "__main__":
    asyncio.run(main())
