"""
AIOps Monitoring Service - Comprehensive Metrics Collection
Implements 6 categories: Availability, Performance, Database, Infrastructure, Application, Incidents
"""

import os
import time
import asyncio
import hashlib
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
import asyncpg
import aiohttp
from collections import defaultdict

NETDATA_URL = os.getenv("NETDATA_URL", "http://localhost:19999")
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://aiops:aiops_password@localhost:5432/peekaping")

# Thresholds from requirements
THRESHOLDS = {
    "availability": {
        "site_down": {"critical": True},
        "uptime_percentage": {"critical": 99.9}
    },
    "performance": {
        "page_load_time_ms": {"warning": 10000},  # 10 seconds
        "http_5xx_count": {"critical": 1},
        "error_rate_percent": {"warning": 5, "critical": 10}
    },
    "database": {
        "query_latency_ms": {"warning": 3000},
        "slow_query_ms": {"warning": 1000},
        "connection_pool_percent": {"warning": 80}
    },
    "infrastructure": {
        "cpu_percent": {"warning": 80},
        "memory_percent": {"warning": 80},
        "disk_percent": {"warning": 80}
    },
    "application": {
        "errors_per_hour": {"warning": 100},
        "unique_errors_daily": {"info": 5}
    },
    "incidents": {
        "consecutive_failures": {"critical": 3},
        "service_down": {"critical": True}
    }
}


class MetricsCollector:
    """Collects and evaluates metrics across all categories"""
    
    def __init__(self):
        self.db_pool = None
        self.session = None
        self.error_cache = defaultdict(int)  # Track error signatures
        self.service_health = {}  # Track service health status
        
    async def initialize(self):
        """Initialize database connection and HTTP session"""
        try:
            self.db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10))
            await self._ensure_tables()
            await self._load_alert_rules()
            print("✅ Monitoring service initialized")
        except Exception as e:
            print(f"❌ Monitoring service initialization error: {e}")
    
    async def close(self):
        """Cleanup resources"""
        if self.db_pool:
            await self.db_pool.close()
        if self.session:
            await self.session.close()
    
    async def _ensure_tables(self):
        """Create metrics tables if they don't exist"""
        async with self.db_pool.acquire() as conn:
            # Metrics history table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS metrics_history (
                    id SERIAL PRIMARY KEY,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    category VARCHAR(50) NOT NULL,
                    metric_name VARCHAR(100) NOT NULL,
                    value NUMERIC NOT NULL,
                    threshold NUMERIC,
                    severity VARCHAR(20),
                    metadata JSONB
                )
            """)
            
            # Active alerts table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS active_alerts (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    category VARCHAR(50) NOT NULL,
                    metric_name VARCHAR(100) NOT NULL,
                    severity VARCHAR(20) NOT NULL,
                    threshold NUMERIC,
                    current_value NUMERIC NOT NULL,
                    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    acknowledged BOOLEAN DEFAULT FALSE,
                    acknowledged_at TIMESTAMPTZ,
                    acknowledged_by VARCHAR(100),
                    resolved BOOLEAN DEFAULT FALSE,
                    resolved_at TIMESTAMPTZ,
                    metadata JSONB
                )
            """)
            
            # Alert rules table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS alert_rules (
                    id SERIAL PRIMARY KEY,
                    category VARCHAR(50) NOT NULL,
                    metric_name VARCHAR(100) NOT NULL,
                    threshold NUMERIC NOT NULL,
                    comparison VARCHAR(10) NOT NULL,
                    severity VARCHAR(20) NOT NULL,
                    enabled BOOLEAN DEFAULT TRUE,
                    cooldown_seconds INT DEFAULT 300,
                    metadata JSONB
                )
            """)
            
            # Error logs table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS error_logs (
                    id SERIAL PRIMARY KEY,
                    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    error_type VARCHAR(100) NOT NULL,
                    error_message TEXT NOT NULL,
                    error_signature VARCHAR(64) NOT NULL,
                    stack_trace TEXT,
                    context JSONB,
                    count INT DEFAULT 1
                )
            """)
            
            # Service health table
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS service_health (
                    id SERIAL PRIMARY KEY,
                    service_name VARCHAR(100) NOT NULL UNIQUE,
                    last_check TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    status VARCHAR(20) NOT NULL,
                    response_time_ms INT,
                    consecutive_failures INT DEFAULT 0,
                    last_error TEXT,
                    metadata JSONB
                )
            """)
            
            print("✅ Metrics tables ensured")
    
    async def _load_alert_rules(self):
        """Load default alert rules if table is empty"""
        async with self.db_pool.acquire() as conn:
            count = await conn.fetchval("SELECT COUNT(*) FROM alert_rules")
            if count == 0:
                # Insert default rules based on THRESHOLDS
                rules = [
                    # Availability
                    ('availability', 'uptime_percentage', 99.9, '<', 'critical', True, 300, None),
                    
                    # Performance
                    ('performance', 'page_load_time_ms', 10000, '>', 'warning', True, 300, None),
                    ('performance', 'http_5xx_count', 1, '>=', 'critical', True, 60, None),
                    ('performance', 'error_rate_percent', 5, '>', 'warning', True, 300, None),
                    
                    # Database
                    ('database', 'query_latency_ms', 3000, '>', 'warning', True, 300, None),
                    ('database', 'connection_pool_percent', 80, '>', 'warning', True, 300, None),
                    
                    # Infrastructure
                    ('infrastructure', 'cpu_percent', 80, '>', 'warning', True, 300, None),
                    ('infrastructure', 'memory_percent', 80, '>', 'warning', True, 300, None),
                    ('infrastructure', 'disk_percent', 80, '>', 'warning', True, 300, None),
                    
                    # Application
                    ('application', 'errors_per_hour', 100, '>', 'warning', True, 3600, None),
                    
                    # Incidents
                    ('incidents', 'consecutive_failures', 3, '>=', 'critical', True, 300, None),
                ]
                
                await conn.executemany("""
                    INSERT INTO alert_rules 
                    (category, metric_name, threshold, comparison, severity, enabled, cooldown_seconds, metadata)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """, rules)
                
                print(f"✅ Inserted {len(rules)} default alert rules")
    
    # ============================================================
    # 1. AVAILABILITY METRICS
    # ============================================================
    
    async def collect_availability_metrics(self) -> Dict[str, Any]:
        """Monitor site/service availability and connectivity"""
        metrics = {
            "category": "availability",
            "timestamp": datetime.utcnow().isoformat(),
            "metrics": {}
        }
        
        # Check main services
        services_to_check = [
            {"name": "frontend", "url": "http://localhost:3001/", "critical": True},
            {"name": "brain", "url": "http://localhost:8000/health", "critical": True},
            {"name": "netdata", "url": f"{NETDATA_URL}/api/v1/info", "critical": True},
        ]
        
        for service in services_to_check:
            is_up, response_time = await self._check_service_health(service["url"])
            
            metrics["metrics"][f"{service['name']}_status"] = {
                "value": 1 if is_up else 0,
                "response_time_ms": response_time,
                "is_critical": service["critical"]
            }
            
            # Store in service_health table
            await self._update_service_health(service["name"], is_up, response_time)
            
            # Trigger alert if down
            if not is_up and service["critical"]:
                await self._trigger_alert(
                    category="availability",
                    metric_name=f"{service['name']}_down",
                    severity="critical",
                    current_value=0,
                    threshold=1,
                    metadata={"service": service["name"], "url": service["url"]}
                )
        
        # Calculate overall uptime
        uptime_percentage = await self._calculate_uptime()
        metrics["metrics"]["uptime_percentage"] = {
            "value": uptime_percentage,
            "threshold": 99.9
        }
        
        if uptime_percentage < 99.9:
            await self._trigger_alert(
                category="availability",
                metric_name="uptime_percentage",
                severity="critical",
                current_value=uptime_percentage,
                threshold=99.9
            )
        
        await self._store_metrics(metrics)
        return metrics
    
    async def _check_service_health(self, url: str) -> tuple[bool, int]:
        """Check if a service is responsive"""
        try:
            start = time.time()
            async with self.session.get(url) as resp:
                response_time = int((time.time() - start) * 1000)
                return resp.status < 500, response_time
        except Exception as e:
            print(f"Service check failed for {url}: {e}")
            return False, 0
    
    async def _update_service_health(self, service_name: str, is_up: bool, response_time: int):
        """Update service health status in database"""
        async with self.db_pool.acquire() as conn:
            status = "up" if is_up else "down"
            
            # Get current consecutive failures
            current = await conn.fetchrow(
                "SELECT consecutive_failures FROM service_health WHERE service_name = $1",
                service_name
            )
            
            consecutive_failures = 0
            if current:
                consecutive_failures = 0 if is_up else current['consecutive_failures'] + 1
            else:
                consecutive_failures = 0 if is_up else 1
            
            await conn.execute("""
                INSERT INTO service_health 
                (service_name, last_check, status, response_time_ms, consecutive_failures)
                VALUES ($1, NOW(), $2, $3, $4)
                ON CONFLICT (service_name) DO UPDATE SET
                    last_check = EXCLUDED.last_check,
                    status = EXCLUDED.status,
                    response_time_ms = EXCLUDED.response_time_ms,
                    consecutive_failures = EXCLUDED.consecutive_failures
            """, service_name, status, response_time, consecutive_failures)
    
    async def _calculate_uptime(self) -> float:
        """Calculate uptime percentage from last 24 hours"""
        async with self.db_pool.acquire() as conn:
            # Get health checks from last 24 hours
            result = await conn.fetchrow("""
                SELECT 
                    COUNT(*) as total_checks,
                    COUNT(*) FILTER (WHERE status = 'up') as up_checks
                FROM service_health
                WHERE last_check > NOW() - INTERVAL '24 hours'
            """)
            
            if result and result['total_checks'] > 0:
                return (result['up_checks'] / result['total_checks']) * 100
            return 100.0
    
    # ============================================================
    # 2. PERFORMANCE METRICS
    # ============================================================
    
    async def collect_performance_metrics(self) -> Dict[str, Any]:
        """Monitor page load times and HTTP errors"""
        metrics = {
            "category": "performance",
            "timestamp": datetime.utcnow().isoformat(),
            "metrics": {}
        }
        
        # Check frontend load time
        page_load_time = await self._measure_page_load_time("http://localhost:3001/")
        metrics["metrics"]["page_load_time_ms"] = {
            "value": page_load_time,
            "threshold": 10000
        }
        
        if page_load_time > 10000:
            await self._trigger_alert(
                category="performance",
                metric_name="page_load_time_ms",
                severity="warning",
                current_value=page_load_time,
                threshold=10000
            )
        
        # Check for 5xx errors (from recent logs or metrics)
        http_5xx_count = await self._count_recent_5xx_errors()
        metrics["metrics"]["http_5xx_count"] = {
            "value": http_5xx_count,
            "threshold": 1
        }
        
        if http_5xx_count >= 1:
            await self._trigger_alert(
                category="performance",
                metric_name="http_5xx_count",
                severity="critical",
                current_value=http_5xx_count,
                threshold=1
            )
        
        # Calculate error rate
        error_rate = await self._calculate_error_rate()
        metrics["metrics"]["error_rate_percent"] = {
            "value": error_rate,
            "threshold": 5
        }
        
        if error_rate > 5:
            await self._trigger_alert(
                category="performance",
                metric_name="error_rate_percent",
                severity="warning",
                current_value=error_rate,
                threshold=5
            )
        
        await self._store_metrics(metrics)
        return metrics
    
    async def _measure_page_load_time(self, url: str) -> int:
        """Measure page load time in milliseconds"""
        try:
            start = time.time()
            async with self.session.get(url) as resp:
                await resp.text()  # Ensure full page is loaded
                return int((time.time() - start) * 1000)
        except:
            return 99999  # Return high value on failure
    
    async def _count_recent_5xx_errors(self) -> int:
        """Count 5xx errors in last 5 minutes"""
        # This would normally check application logs or metrics
        # For now, return 0 as placeholder
        return 0
    
    async def _calculate_error_rate(self) -> float:
        """Calculate error rate from recent requests"""
        # This would calculate from request logs
        # For now, return 0 as placeholder
        return 0.0
    
    # ============================================================
    # 3. DATABASE METRICS
    # ============================================================
    
    async def collect_database_metrics(self) -> Dict[str, Any]:
        """Monitor database query performance and connections"""
        metrics = {
            "category": "database",
            "timestamp": datetime.utcnow().isoformat(),
            "metrics": {}
        }
        
        # Test query latency
        query_latency = await self._measure_query_latency()
        metrics["metrics"]["query_latency_ms"] = {
            "value": query_latency,
            "threshold": 3000
        }
        
        if query_latency > 3000:
            await self._trigger_alert(
                category="database",
                metric_name="query_latency_ms",
                severity="warning",
                current_value=query_latency,
                threshold=3000
            )
        
        # Check connection pool usage
        pool_usage = await self._get_connection_pool_usage()
        metrics["metrics"]["connection_pool_percent"] = {
            "value": pool_usage,
            "threshold": 80
        }
        
        if pool_usage > 80:
            await self._trigger_alert(
                category="database",
                metric_name="connection_pool_percent",
                severity="warning",
                current_value=pool_usage,
                threshold=80
            )
        
        await self._store_metrics(metrics)
        return metrics
    
    async def _measure_query_latency(self) -> int:
        """Measure a test query latency"""
        try:
            async with self.db_pool.acquire() as conn:
                start = time.time()
                await conn.fetchval("SELECT COUNT(*) FROM pending_actions WHERE created_at > NOW() - INTERVAL '1 day'")
                latency = int((time.time() - start) * 1000)
                return latency
        except:
            return 9999
    
    async def _get_connection_pool_usage(self) -> float:
        """Get current connection pool utilization percentage"""
        if self.db_pool:
            size = self.db_pool.get_size()
            max_size = self.db_pool.get_max_size()
            return (size / max_size) * 100 if max_size > 0 else 0
        return 0
    
    # ============================================================
    # 4. INFRASTRUCTURE METRICS
    # ============================================================
    
    async def collect_infrastructure_metrics(self) -> Dict[str, Any]:
        """Monitor CPU, Memory, Disk usage via Netdata"""
        metrics = {
            "category": "infrastructure",
            "timestamp": datetime.utcnow().isoformat(),
            "metrics": {}
        }
        
        # Get CPU usage
        cpu_percent = await self._get_netdata_metric("system.cpu", aggregate=True)
        metrics["metrics"]["cpu_percent"] = {
            "value": cpu_percent,
            "threshold": 80
        }
        
        if cpu_percent > 80:
            await self._trigger_alert(
                category="infrastructure",
                metric_name="cpu_percent",
                severity="warning",
                current_value=cpu_percent,
                threshold=80
            )
        
        # Get Memory usage
        memory_percent = await self._get_memory_usage_percent()
        metrics["metrics"]["memory_percent"] = {
            "value": memory_percent,
            "threshold": 80
        }
        
        if memory_percent > 80:
            await self._trigger_alert(
                category="infrastructure",
                metric_name="memory_percent",
                severity="warning",
                current_value=memory_percent,
                threshold=80
            )
        
        # Get Disk usage
        disk_percent = await self._get_disk_usage_percent()
        metrics["metrics"]["disk_percent"] = {
            "value": disk_percent,
            "threshold": 80
        }
        
        if disk_percent > 80:
            await self._trigger_alert(
                category="infrastructure",
                metric_name="disk_percent",
                severity="warning",
                current_value=disk_percent,
                threshold=80
            )
        
        await self._store_metrics(metrics)
        return metrics
    
    async def _get_netdata_metric(self, chart: str, aggregate: bool = False) -> float:
        """Get metric value from Netdata"""
        try:
            url = f"{NETDATA_URL}/api/v1/data?chart={chart}&after=-1&points=1&format=json"
            async with self.session.get(url) as resp:
                data = await resp.json()
                if data.get('data') and len(data['data']) > 0:
                    values = data['data'][0][1:]  # Skip timestamp
                    if aggregate:
                        return sum(abs(v) for v in values if v is not None)
                    return values[0] if values else 0
        except:
            return 0
        return 0
    
    async def _get_memory_usage_percent(self) -> float:
        """Calculate memory usage percentage from Netdata"""
        try:
            url = f"{NETDATA_URL}/api/v1/data?chart=system.ram&after=-1&points=1&format=json"
            async with self.session.get(url) as resp:
                data = await resp.json()
                if data.get('data') and len(data['data']) > 0:
                    values = data['data'][0][1:]
                    total = sum(abs(v) for v in values if v is not None)
                    # Assuming used memory is the second value
                    used = abs(values[1]) if len(values) > 1 else 0
                    return (used / total * 100) if total > 0 else 0
        except:
            return 0
        return 0
    
    async def _get_disk_usage_percent(self) -> float:
        """Get disk usage percentage from Netdata"""
        try:
            url = f"{NETDATA_URL}/api/v1/data?chart=disk_space._&after=-1&points=1&format=json"
            async with self.session.get(url) as resp:
                data = await resp.json()
                if data.get('data') and len(data['data']) > 0:
                    values = data['data'][0][1:]
                    # Disk usage is typically reported as percentage
                    return abs(values[0]) if values else 0
        except:
            return 0
        return 0
    
    # ============================================================
    # 5. APPLICATION METRICS
    # ============================================================
    
    async def collect_application_metrics(self) -> Dict[str, Any]:
        """Monitor application errors and logs"""
        metrics = {
            "category": "application",
            "timestamp": datetime.utcnow().isoformat(),
            "metrics": {}
        }
        
        # Count errors in last hour
        errors_per_hour = await self._count_errors_last_hour()
        metrics["metrics"]["errors_per_hour"] = {
            "value": errors_per_hour,
            "threshold": 100
        }
        
        if errors_per_hour > 100:
            await self._trigger_alert(
                category="application",
                metric_name="errors_per_hour",
                severity="warning",
                current_value=errors_per_hour,
                threshold=100
            )
        
        # Count unique error types today
        unique_errors = await self._count_unique_errors_daily()
        metrics["metrics"]["unique_errors_daily"] = {
            "value": unique_errors,
            "threshold": 5
        }
        
        await self._store_metrics(metrics)
        return metrics
    
    async def _count_errors_last_hour(self) -> int:
        """Count error log entries from last hour"""
        async with self.db_pool.acquire() as conn:
            count = await conn.fetchval("""
                SELECT COALESCE(SUM(count), 0)
                FROM error_logs
                WHERE timestamp > NOW() - INTERVAL '1 hour'
            """)
            return count or 0
    
    async def _count_unique_errors_daily(self) -> int:
        """Count unique error signatures from today"""
        async with self.db_pool.acquire() as conn:
            count = await conn.fetchval("""
                SELECT COUNT(DISTINCT error_signature)
                FROM error_logs
                WHERE timestamp > CURRENT_DATE
            """)
            return count or 0
    
    async def log_error(self, error_type: str, error_message: str, stack_trace: str = None, context: dict = None):
        """Log an application error"""
        # Generate error signature
        signature_content = f"{error_type}:{error_message}"
        error_signature = hashlib.sha256(signature_content.encode()).hexdigest()
        
        async with self.db_pool.acquire() as conn:
            # Check if this error already exists
            existing = await conn.fetchrow("""
                SELECT id, count FROM error_logs
                WHERE error_signature = $1 AND timestamp > NOW() - INTERVAL '1 hour'
            """, error_signature)
            
            if existing:
                # Increment count
                await conn.execute("""
                    UPDATE error_logs SET count = count + 1, timestamp = NOW()
                    WHERE id = $1
                """, existing['id'])
            else:
                # Insert new error
                await conn.execute("""
                    INSERT INTO error_logs 
                    (error_type, error_message, error_signature, stack_trace, context)
                    VALUES ($1, $2, $3, $4, $5)
                """, error_type, error_message, error_signature, stack_trace, context)
    
    # ============================================================
    # 6. INCIDENT METRICS
    # ============================================================
    
    async def collect_incident_metrics(self) -> Dict[str, Any]:
        """Monitor service incidents and failures"""
        metrics = {
            "category": "incidents",
            "timestamp": datetime.utcnow().isoformat(),
            "metrics": {}
        }
        
        # Check for services with consecutive failures
        critical_services = await self._get_services_with_consecutive_failures()
        metrics["metrics"]["critical_services"] = {
            "value": len(critical_services),
            "services": critical_services
        }
        
        for service in critical_services:
            await self._trigger_alert(
                category="incidents",
                metric_name="service_down",
                severity="critical",
                current_value=service['consecutive_failures'],
                threshold=3,
                metadata={"service": service['service_name']}
            )
        
        await self._store_metrics(metrics)
        return metrics
    
    async def _get_services_with_consecutive_failures(self) -> List[Dict]:
        """Get services that have failed multiple times consecutively"""
        async with self.db_pool.acquire() as conn:
            services = await conn.fetch("""
                SELECT service_name, consecutive_failures, last_error
                FROM service_health
                WHERE consecutive_failures >= 3
            """)
            return [dict(s) for s in services]
    
    # ============================================================
    # HELPER METHODS
    # ============================================================
    
    async def _store_metrics(self, metrics_data: Dict):
        """Store metrics in history table"""
        import json
        async with self.db_pool.acquire() as conn:
            for metric_name, metric_value in metrics_data["metrics"].items():
                value = metric_value.get("value", 0)
                threshold = metric_value.get("threshold")
                
                await conn.execute("""
                    INSERT INTO metrics_history 
                    (category, metric_name, value, threshold, metadata)
                    VALUES ($1, $2, $3, $4, $5)
                """, metrics_data["category"], metric_name, value, threshold, json.dumps(metric_value))
    
    async def _trigger_alert(self, category: str, metric_name: str, severity: str, 
                            current_value: float, threshold: float, metadata: dict = None):
        """Trigger an alert if not already active"""
        import json
        async with self.db_pool.acquire() as conn:
            # Check if alert already exists and is not resolved
            existing = await conn.fetchrow("""
                SELECT id FROM active_alerts
                WHERE category = $1 AND metric_name = $2 AND resolved = FALSE
            """, category, metric_name)
            
            if not existing:
                # Create new alert
                await conn.execute("""
                    INSERT INTO active_alerts 
                    (category, metric_name, severity, threshold, current_value, metadata)
                    VALUES ($1, $2, $3, $4, $5, $6)
                """, category, metric_name, severity, threshold, current_value, json.dumps(metadata or {}))
                
                print(f"🚨 ALERT: {severity.upper()} - {category}/{metric_name} = {current_value} (threshold: {threshold})")
    
    async def get_all_metrics_summary(self) -> Dict:
        """Get summary of all metric categories"""
        summary = {
            "timestamp": datetime.utcnow().isoformat(),
            "categories": {}
        }
        
        # Collect all metrics
        summary["categories"]["availability"] = await self.collect_availability_metrics()
        summary["categories"]["performance"] = await self.collect_performance_metrics()
        summary["categories"]["database"] = await self.collect_database_metrics()
        summary["categories"]["infrastructure"] = await self.collect_infrastructure_metrics()
        summary["categories"]["application"] = await self.collect_application_metrics()
        summary["categories"]["incidents"] = await self.collect_incident_metrics()
        
        # Get active alerts count
        async with self.db_pool.acquire() as conn:
            alerts_count = await conn.fetchval("""
                SELECT COUNT(*) FROM active_alerts WHERE resolved = FALSE
            """)
            summary["active_alerts_count"] = alerts_count
        
        return summary
    
    async def get_active_alerts(self) -> List[Dict]:
        """Get all unresolved alerts"""
        async with self.db_pool.acquire() as conn:
            alerts = await conn.fetch("""
                SELECT * FROM active_alerts
                WHERE resolved = FALSE
                ORDER BY severity DESC, triggered_at DESC
                LIMIT 50
            """)
            return [dict(a) for a in alerts]
    
    async def acknowledge_alert(self, alert_id: str, acknowledged_by: str):
        """Acknowledge an alert"""
        async with self.db_pool.acquire() as conn:
            await conn.execute("""
                UPDATE active_alerts
                SET acknowledged = TRUE, acknowledged_at = NOW(), acknowledged_by = $2
                WHERE id = $1
            """, alert_id, acknowledged_by)
    
    async def resolve_alert(self, alert_id: str):
        """Mark alert as resolved"""
        async with self.db_pool.acquire() as conn:
            await conn.execute("""
                UPDATE active_alerts
                SET resolved = TRUE, resolved_at = NOW()
                WHERE id = $1
            """, alert_id)


# Global instance
metrics_collector = MetricsCollector()
