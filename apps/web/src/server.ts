import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

const app = new Hono()

// Serve static files
app.use('/public/*', serveStatic({ root: './' }))

// API: Get system metrics from Netdata
app.get('/api/metrics', async (c) => {
  try {
    const response = await fetch('http://localhost:19999/api/v1/data?chart=system.cpu&after=-60&points=60&format=json')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to fetch metrics' }, 500)
  }
})

// API: Get ALL charts from Netdata
app.get('/api/charts', async (c) => {
  try {
    const response = await fetch('http://localhost:19999/api/v1/charts')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to fetch charts' }, 500)
  }
})

// API: Get specific chart data with history
app.get('/api/chart/:chart', async (c) => {
  const chart = c.req.param('chart')
  const after = c.req.query('after') || '-60'
  const points = c.req.query('points') || '60'
  try {
    const response = await fetch(`http://localhost:19999/api/v1/data?chart=${chart}&after=${after}&points=${points}&format=json`)
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to fetch chart' }, 500)
  }
})

// API: Get active alerts from Netdata
// API: Get Alerts (Active + History)
app.get('/api/alerts', async (c) => {
  try {
    // Call Brain service for consolidated alerts
    const response = await fetch('http://localhost:8000/api/active-alerts')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to fetch alerts', active: [], history: [] }, 500)
  }
})

// API: Diagnose Alert
app.post('/api/alerts/:id/diagnose', async (c) => {
  try {
    const body = await c.req.json()
    const response = await fetch('http://localhost:8000/api/diagnose-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Diagnosis failed' }, 500)
  }
})

// API: Approve Remediation (Create Incident)
app.post('/api/alerts/:id/approve', async (c) => {
  try {
    const body = await c.req.json()
    const response = await fetch('http://localhost:8000/api/create-incident', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `Alert Remediation: ${body.metric_name}`,
        description: `User approved remediation for alert ${body.alert_id}`,
        severity: body.severity || "MEDIUM",
        alert_id: body.alert_id,
        remediation_plan: body.remediation
      })
    })
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to approve remediation' }, 500)
  }
})

// API: Reject Remediation
app.post('/api/alerts/:id/reject', async (c) => {
  try {
    // For now just acknowledge the alert? Or log rejection?
    // We'll just return success for UI feedback
    return c.json({ status: "rejected" })
  } catch (error) {
    return c.json({ error: 'Failed to reject' }, 500)
  }
})

// API: Get system info
app.get('/api/info', async (c) => {
  try {
    const response = await fetch('http://localhost:19999/api/v1/info')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to fetch info' }, 500)
  }
})

// API: Get Top Processes using ps command
app.get('/api/processes', async (c) => {
  try {
    const sortBy = c.req.query('sort') || 'cpu';
    const sortFlag = sortBy === 'memory' ? '-%mem' : '-%cpu';
    const proc = Bun.spawn(['ps', 'aux', `--sort=${sortFlag}`]);
    const output = await new Response(proc.stdout).text();
    const lines = output.trim().split('\n');

    // Skip header, take top 10
    const processes = lines.slice(1, 11).map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        user: parts[0],
        pid: parts[1],
        cpu: parseFloat(parts[2]) || 0,
        memory: parseFloat(parts[3]) || 0,
        command: parts.slice(10).join(' ').substring(0, 50)
      };
    });

    return c.json({ processes });
  } catch (error) {
    return c.json({ error: 'Failed to fetch processes', processes: [] }, 500);
  }
})

// API: Get Top Disk Usage Directories
app.get('/api/disk-usage', async (c) => {
  try {
    // Get total disk space first (use shell to avoid permission issues)
    const dfProc = Bun.spawn(['sh', '-c', 'df -B1 / | tail -1']);
    const dfOutput = await new Response(dfProc.stdout).text();
    await dfProc.exited;

    let totalDiskBytes = 500000000000; // Default 500GB
    const dfParts = dfOutput.trim().split(/\s+/);
    if (dfParts.length > 1) {
      totalDiskBytes = parseInt(dfParts[1]) || 500000000000;
    }

    // Get top directories (use shell with error suppression)
    const proc = Bun.spawn(['sh', '-c', 'du -h --max-depth=1 /home /var /usr /opt 2>/dev/null | sort -h -r | head -20']);
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = output.trim().split('\n').filter(l => l.length > 0);

    const directories = lines.map((line, idx) => {
      const parts = line.trim().split(/\s+/);
      const size = parts[0] || '0';
      const path = parts[1] || '/';

      // Parse human-readable size to bytes
      let sizeBytes = 0;
      const match = size.match(/^([\d.]+)([KMGT]?)$/i);
      if (match) {
        const num = parseFloat(match[1]);
        const unit = (match[2] || '').toUpperCase();
        const multipliers: Record<string, number> = { '': 1, 'K': 1024, 'M': 1048576, 'G': 1073741824, 'T': 1099511627776 };
        sizeBytes = num * (multipliers[unit] || 1);
      }

      return { idx: idx + 1, path, size, sizeBytes };
    });

    // Take top 10 (already sorted by shell command)
    const top = directories.slice(0, 10);

    // Calculate percentage based on TOTAL disk space
    const withPercent = top.map(d => ({
      ...d,
      percent: ((d.sizeBytes / totalDiskBytes) * 100).toFixed(1)
    }));

    return c.json({ directories: withPercent, totalDiskBytes });
  } catch (error) {
    console.error('Disk usage API error:', error);
    return c.json({ error: String(error), directories: [] }, 500);
  }
})

// API: Chat with AI Brain
app.post('/api/chat', async (c) => {
  const body = await c.req.json()
  const message = body.message

  try {
    const response = await fetch('http://localhost:8000/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    })
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Brain not available', response: 'The AI Brain is starting up...' }, 503)
  }
})

// API: Get pending actions (HITL)
app.get('/api/pending-actions', async (c) => {
  try {
    const response = await fetch('http://localhost:8000/pending-actions')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ actions: [] })
  }
})

// API: Approve/Reject action (HITL)
app.post('/api/actions/:id/approve', async (c) => {
  const actionId = c.req.param('id')
  const body = await c.req.json()

  try {
    const response = await fetch(`http://localhost:8000/actions/${actionId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to process approval' }, 500)
  }
})

// API: Get audit log
app.get('/api/audit-log', async (c) => {
  try {
    const response = await fetch('http://localhost:8000/audit-log')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ logs: [] })
  }
})

// API: Get network packets
app.get('/api/network/packets', async (c) => {
  try {
    const limit = c.req.query('limit') || '50'
    const response = await fetch(`http://localhost:8000/api/network/packets?limit=${limit}`)
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ packets: [], count: 0, error: 'Network sniffer not available' })
  }
})

// API: Get network stats
app.get('/api/network/stats', async (c) => {
  try {
    const response = await fetch('http://localhost:8000/api/network/stats')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({
      total_packets: 0,
      packets_per_second: 0,
      suspicious_count: 0,
      protocols: {},
      is_running: false,
      scapy_available: false
    })
  }
})

// Main dashboard HTML - OpenAI Theme BEAST MODE
app.get('/', (c) => {
  return c.html(dashboardHTML)
})

const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AIOps Command Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #000000;
      --bg-secondary: #0d0d0d;
      --bg-card: #171717;
      --bg-card-hover: #1f1f1f;
      --border: #2d2d2d;
      --text-primary: #ffffff;
      --text-secondary: #ababab;
      --text-muted: #6b6b6b;
      --accent: #10a37f;
      --accent-light: #1ec99f;
      --warning: #f5a623;
      --error: #ff4d4f;
      --info: #43a9ff;
      --purple: #a855f7;
      --chart-1: #10a37f;
      --chart-2: #43a9ff;
      --chart-3: #f5a623;
      --chart-4: #a855f7;
      --chart-4: #a855f7;
      --chart-5: #ff4d4f;
    }

    [data-theme="light"] {
      --bg-primary: #ffffff;
      --bg-secondary: #f9f9f9;
      --bg-card: #ffffff;
      --bg-card-hover: #f0f0f0;
      --border: #e5e5e5;
      --text-primary: #111111;
      --text-secondary: #555555;
      --text-muted: #888888;
      --accent: #10a37f; /* OpenaAI Green stays similar */
      --accent-light: #1ec99f;
      --warning: #f5a623; 
      --error: #ef4444;
      --info: #3b82f6;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
    }
    
    /* Header - OpenAI Style */
    .header {
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      padding: 12px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 1000;
    }
    
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    .logo-icon {
      width: 36px;
      height: 36px;
      background: var(--text-primary);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--bg-primary);
      font-weight: 700;
      font-size: 14px;
    }
    
    .logo-text {
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }
    
    .header-right {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    
    /* OpenAI White Buttons */
    .btn {
      background: var(--text-primary);
      color: var(--bg-primary);
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      font-family: inherit;
    }
    
    .btn:hover {
      background: #e5e5e5;
    }
    
    .btn-sm {
      padding: 6px 12px;
      font-size: 13px;
    }
    
    .btn-outline {
      background: transparent;
      color: var(--text-primary);
      border: 1px solid var(--border);
    }
    
    .btn-outline:hover {
      background: var(--bg-card);
    }
    
    .status-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent);
      animation: pulse 2s infinite;
    }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    /* Main Layout */
    .main {
      display: flex;
      height: calc(100vh - 61px);
    }
    
    /* Sidebar */
    .sidebar {
      width: 280px;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .sidebar-header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
    }
    
    .sidebar-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .sidebar-content {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    
    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;
      font-size: 14px;
      color: var(--text-secondary);
      margin-bottom: 2px;
    }
    
    .nav-item:hover {
      background: var(--bg-card);
      color: var(--text-primary);
    }
    
    .nav-item.active {
      background: var(--bg-card);
      color: var(--text-primary);
    }
    
    .nav-icon {
      font-size: 16px;
    }
    
    /* Content Area */
    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    /* Tabs */
    .tabs {
      display: flex;
      gap: 4px;
      padding: 12px 24px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
    }
    
    .tab {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;
    }
    
    .tab:hover {
      color: var(--text-primary);
    }
    
    .tab.active {
      background: var(--text-primary);
      color: var(--bg-primary);
    }
    
    .view-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      width: 100%;
    }
    
    /* Dashboard Grid */
    .dashboard {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
      display: flex;
      flex-direction: column;
    }
    
    .dashboard-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    
    .dashboard-title {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    
    .time-range {
      display: flex;
      gap: 8px;
    }
    
    /* Stats Row */
    .stats-row {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      transition: all 0.2s;
    }
    
    .stat-card:hover {
      border-color: var(--border);
      background: var(--bg-card-hover);
    }
    
    .stat-label {
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    
    .stat-value {
      font-size: 28px;
      font-weight: 600;
      color: var(--text-primary);
      font-family: 'JetBrains Mono', monospace;
      letter-spacing: -0.02em;
    }
    
    .stat-unit {
      font-size: 14px;
      color: var(--text-muted);
      margin-left: 4px;
    }
    
    .stat-trend {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      font-size: 12px;
    }
    
    .stat-trend.up { color: var(--accent); }
    .stat-trend.down { color: var(--error); }
    
    /* Charts Grid */
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    
    .chart-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      min-height: 280px;
    }
    
    .chart-card.full-width {
      grid-column: span 2;
    }
    
    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    
    .chart-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }
    
    .chart-actions {
      display: flex;
      gap: 8px;
    }
    
    .chart-container {
      position: relative;
      height: 200px;
    }
    
    .chart-canvas {
      width: 100%;
      height: 100%;
    }
    
    /* Alerts Panel */
    .alerts-panel {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 24px;
    }
    
    .alerts-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }
    
    .alerts-title {
      font-size: 14px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .alerts-count {
      background: var(--warning);
      color: var(--bg-primary);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 600;
    }
    
    .alerts-list {
      max-height: 200px;
      overflow-y: auto;
    }
    
    .alert-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      transition: background 0.15s;
    }
    
    .alert-row:last-child {
      border-bottom: none;
    }
    
    .alert-row:hover {
      background: var(--bg-card-hover);
    }
    
    .alert-severity {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    
    .alert-severity.warning { background: var(--warning); }
    .alert-severity.critical { background: var(--error); }
    .alert-severity.info { background: var(--info); }
    
    .alert-content {
      flex: 1;
    }
    
    .alert-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
    }
    
    .alert-meta {
      font-size: 12px;
      color: var(--text-muted);
    }
    
    /* Chat Panel */
    .chat-panel {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 480px; 
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      max-height: 600px;
      z-index: 1000;
    }
    
    .chat-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    
    .chat-title {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      max-height: 300px;
    }
    
    .chat-message {
      margin-bottom: 16px;
    }
    
    .chat-message.user .chat-bubble {
      background: var(--text-primary);
      color: var(--bg-primary);
      margin-left: 40px;
    }
    
    .chat-message.ai .chat-bubble {
      background: var(--bg-secondary);
      margin-right: 40px;
    }
    
    .chat-bubble {
      padding: 14px 18px;
      border-radius: 12px;
      font-size: 15px;
      line-height: 1.6;
    }
    
    .chat-input-wrapper {
      padding: 16px;
      border-top: 1px solid var(--border);
      position: relative;
    }
    
    .chat-input {
      width: 100%;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 50px 16px 18px;
      color: var(--text-primary);
      font-size: 15px;
      font-family: inherit;
      outline: none;
      resize: none;
    }
    
    .chat-input:focus {
      border-color: var(--accent);
    }
    
    .chat-send {
      position: absolute;
      right: 24px;
      top: 50%;
      transform: translateY(-50%);
      background: var(--text-primary);
      color: var(--bg-primary);
      border: none;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    }
    
    /* Slash Menu */
    .slash-menu {
      position: absolute;
      bottom: 100%;
      left: 16px;
      right: 16px;
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 8px;
      max-height: 250px;
      overflow-y: auto;
      display: none;
    }
    
    .slash-menu.visible {
      display: block;
    }
    
    .slash-header {
      padding: 10px 16px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border);
    }
    
    .slash-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 16px;
      cursor: pointer;
      transition: background 0.1s;
    }
    
    .slash-item:hover, .slash-item.selected {
      background: var(--bg-card);
    }
    
    .slash-cmd {
      color: var(--accent);
      font-weight: 500;
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      min-width: 120px;
    }
    
    .slash-desc {
      color: var(--text-secondary);
      font-size: 13px;
    }
    
    /* Process List */
    .process-table {
      width: 100%;
      border-collapse: collapse;
    }
    
    .process-table th {
      text-align: left;
      padding: 12px 16px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 1px solid var(--border);
    }
    
    .process-table td {
      padding: 12px 16px;
      font-size: 14px;
      border-bottom: 1px solid var(--border);
    }
    
    .process-table tr:hover {
      background: var(--bg-card-hover);
    }
    
    .process-name {
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-primary);
    }
    
    .process-bar {
      width: 100px;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    
    .process-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.3s;
    }
    
    /* Typing Indicator */
    .typing-indicator {
      display: flex;
      gap: 4px;
      padding: 8px;
    }
    
    .typing-indicator span {
      width: 6px;
      height: 6px;
      background: var(--text-muted);
      border-radius: 50%;
      animation: typing 1.2s infinite;
    }
    
    .typing-indicator span:nth-child(2) { animation-delay: 0.15s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.3s; }
    
    @keyframes typing {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30% { transform: translateY(-4px); opacity: 1; }
    }
    
    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 6px;
    }
    
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    
    ::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 3px;
    }
    
    ::-webkit-scrollbar-thumb:hover {
      background: #444;
    }
    
    /* Responsive */
    @media (max-width: 1400px) {
      .stats-row {
        grid-template-columns: repeat(3, 1fr);
      }
    }
    
    @media (max-width: 1000px) {
      .charts-grid {
        grid-template-columns: 1fr;
      }
      .chart-card.full-width {
        grid-column: span 1;
      }
    }
  </style>
</head>
<body>
  <!-- Header -->
  <header class="header">
    <div class="logo">
      <div class="logo-icon">AI</div>
      <span class="logo-text">AIOps Command Center</span>
    </div>
    <div class="header-right">
      <div class="status-pill">
        <span class="status-dot"></span>
        <span id="netdataStatus">Connecting...</span>
      </div>
      <button class="btn btn-sm" onclick="refreshAll()">⟳ Refresh</button>
      <button class="btn btn-sm btn-outline" onclick="toggleTheme()">🌓 Theme</button>
      <button class="btn btn-sm btn-outline" onclick="toggleChat()">💬 AI Chat</button>
    </div>
  </header>

  <main class="main">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title">Navigation</div>
      </div>
      <div class="sidebar-content">
        <div class="nav-item active" onclick="showTab('overview')">
          <span class="nav-icon">📊</span>
          <span>Overview</span>
        </div>
        <div class="nav-item" onclick="showTab('cpu')">
          <span class="nav-icon">💻</span>
          <span>CPU</span>
        </div>
        <div class="nav-item" onclick="showTab('memory')">
          <span class="nav-icon">🧠</span>
          <span>Memory</span>
        </div>
        <div class="nav-item" onclick="showTab('disk')">
          <span class="nav-icon">💾</span>
          <span>Disk</span>
        </div>
        <div class="nav-item" onclick="showTab('network')">
          <span class="nav-icon">🌐</span>
          <span>Network</span>
        </div>
        <div class="nav-item" onclick="showTab('alerts')">
          <span class="nav-icon">🚨</span>
          <span>Alerts</span>
        </div>
      </div>
      <div style="padding: 16px; border-top: 1px solid var(--border);">
        <div class="sidebar-title" style="margin-bottom: 12px;">Quick Stats</div>
        <div style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-secondary);">
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span>Uptime</span>
            <span id="uptimeValue" style="color: var(--text-primary);">--</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span>Hostname</span>
            <span id="hostnameValue" style="color: var(--text-primary);">--</span>
          </div>
          <div style="display: flex; justify-content: space-between;">
            <span>Charts</span>
            <span id="chartsCount" style="color: var(--accent);">--</span>
          </div>
        </div>
      </div>
    </aside>

    <!-- Content -->
    <div class="content">
      <!-- Tab Bar -->
      <div class="tabs">
        <div class="tab active" data-tab="overview">Project_1</div>
        <div class="tab" data-tab="cpu">Project_2</div>
        <div class="tab" data-tab="memory">Project_3</div>
        <div class="tab" data-tab="network">Project_4</div>
        <div class="tab" data-tab="disk">Project_5</div>
      </div>

      <!-- VIEW: Overview (default) -->
      <div id="view-overview" class="view-section" style="display: block;">
      <div class="dashboard" id="dashboardContent">
        <!-- Stats Row -->
        <div class="stats-row">
          <div class="stat-card">                                                                   
            <div class="stat-label">CPU Usage</div>
            <div class="stat-value"><span id="cpuStat">--</span><span class="stat-unit">%</span></div>
            <div class="stat-trend up" id="cpuTrend">↑ 0.1%</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Memory Used</div>
            <div class="stat-value"><span id="memStat">--</span><span class="stat-unit">%</span></div>
            <div class="stat-trend" id="memTrend">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Load (1m)</div>
            <div class="stat-value" id="loadStat">--</div>
            <div class="stat-trend" id="loadTrend">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Network In</div>
            <div class="stat-value" id="netInStat">--</div>
            <div class="stat-trend up" id="netInTrend">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Network Out</div>
            <div class="stat-value" id="netOutStat">--</div>
            <div class="stat-trend" id="netOutTrend">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Disk I/O</div>
            <div class="stat-value" id="diskIOStat">--</div>
            <div class="stat-trend" id="diskIOTrend">--</div>
          </div>
        </div>

        <!-- Alerts Panel -->
        <div class="alerts-panel">
          <div class="alerts-header">
            <div class="alerts-title">
              🚨 Active Alerts
              <span class="alerts-count" id="alertsCount">0</span>
            </div>
            <button class="btn btn-sm" onclick="refreshAlerts()">Refresh</button>
          </div>
          <div class="alerts-list" id="alertsList">
            <div class="alert-row" style="justify-content: center; color: var(--text-muted);">
              Loading alerts...
            </div>
          </div>
        </div>

        <!-- HITL: Pending Actions Panel -->
        <div class="alerts-panel" style="border-color: var(--purple); background: rgba(168, 85, 247, 0.05);">
          <div class="alerts-header">
            <div class="alerts-title" style="color: var(--purple);">
              🛠️ Pending Actions (HITL)
              <span class="alerts-count" id="pendingCount" style="background: var(--purple);">0</span>
            </div>
            <button class="btn btn-sm" onclick="refreshPendingActions()">Refresh</button>
          </div>
          <div id="pendingActionsList" style="max-height: 300px; overflow-y: auto;">
            <div class="alert-row" style="justify-content: center; color: var(--text-muted);">
              No pending actions
            </div>
          </div>
        </div>

        <div class="charts-grid">
          <div class="chart-card full-width">
            <div class="chart-header">
              <div class="chart-title">📈 CPU Usage (Last 60s)</div>
              <div class="chart-actions">
                <button class="btn btn-sm btn-outline">1m</button>
                <button class="btn btn-sm btn-outline">5m</button>
                <button class="btn btn-sm btn-outline">15m</button>
              </div>
            </div>
            <div class="chart-container">
              <canvas id="cpuChart" class="chart-canvas"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">🧠 Memory Usage</div>
            </div>
            <div class="chart-container">
              <canvas id="memChart" class="chart-canvas"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">🌐 Network Traffic</div>
            </div>
            <div class="chart-container">
              <canvas id="netChart" class="chart-canvas"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">💾 Disk I/O</div>
            </div>
            <div class="chart-container">
              <canvas id="diskChart" class="chart-canvas"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📊 System Load</div>
            </div>
            <div class="chart-container">
              <canvas id="loadChart" class="chart-canvas"></canvas>
            </div>
          </div>
        </div>

        <!-- Top Processes -->
        <div class="chart-card" style="margin-bottom: 24px;">
          <div class="chart-header">
            <div class="chart-title">⚙️ Top Processes by CPU</div>
            <button class="btn btn-sm" onclick="refreshProcesses()">Refresh</button>
          </div>
          <table class="process-table" id="processTable">
            <thead>
              <tr>
                <th>Process</th>
                <th>CPU %</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody id="processBody">
              <tr>
                <td colspan="3" style="text-align: center; color: var(--text-muted);">Loading...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div><!-- End view-overview -->

    <!-- VIEW: CPU Details -->
    <div id="view-cpu" class="view-section" style="display: none;">
      <div class="dashboard">
        <!-- CPU Overview Stats -->
        <div class="stats-row" style="grid-template-columns: repeat(4, 1fr);">
          <div class="stat-card">
            <div class="stat-label">Total CPU Usage</div>
            <div class="stat-value"><span id="cpuViewTotal">--</span><span class="stat-unit">%</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Load (1m)</div>
            <div class="stat-value" id="cpuViewLoad1">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Load (5m)</div>
            <div class="stat-value" id="cpuViewLoad5">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Load (15m)</div>
            <div class="stat-value" id="cpuViewLoad15">--</div>
          </div>
        </div>

        <!-- CPU Components Grid -->
        <div class="chart-card" style="margin-bottom: 24px;">
          <div class="chart-header">
            <div class="chart-title">🔢 CPU Breakdown</div>
          </div>
          <div id="cpu-cores-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 12px; padding: 16px;">
            <div style="color: var(--text-muted); text-align: center; grid-column: 1/-1;">Loading...</div>
          </div>
        </div>

        <!-- Charts Grid - Same as Overview -->
        <div class="charts-grid">
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📈 CPU Usage (Last 60s)</div>
            </div>
            <div class="chart-container">
              <canvas id="cpuViewChart" class="chart-canvas"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📊 System Load</div>
            </div>
            <div class="chart-container">
              <canvas id="cpuLoadChart" class="chart-canvas"></canvas>
            </div>
          </div>
        </div>

        <!-- Top Processes by CPU -->
        <div class="chart-card" style="margin-top: 24px;">
          <div class="chart-header">
            <div class="chart-title">⚙️ Top Processes by CPU</div>
            <button class="btn btn-sm" onclick="loadCPUProcesses()">Refresh</button>
          </div>
          <table class="process-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th>CPU %</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody id="cpuViewProcessBody">
              <tr>
                <td colspan="4" style="text-align: center; color: var(--text-muted);">Loading...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div><!-- End view-cpu -->

    <!-- VIEW: Memory Details -->
    <div id="view-memory" class="view-section" style="display: none;">
      <div class="dashboard">
        <!-- Memory Overview Stats -->
        <div class="stats-row" style="grid-template-columns: repeat(4, 1fr);">
          <div class="stat-card">
            <div class="stat-label">Total Memory</div>
            <div class="stat-value" id="memViewTotal">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Used Memory</div>
            <div class="stat-value"><span id="memViewUsed">--</span><span class="stat-unit">%</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Swap Total</div>
            <div class="stat-value" id="memViewSwapTotal">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Swap Used</div>
            <div class="stat-value"><span id="memViewSwapUsed">--</span><span class="stat-unit">%</span></div>
          </div>
        </div>

        <!-- Memory Breakdown -->
        <div class="chart-card" style="margin-bottom: 24px;">
          <div class="chart-header">
            <div class="chart-title">🔢 Memory Breakdown</div>
          </div>
          <div id="memory-breakdown-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; padding: 16px;">
            <div style="color: var(--text-muted); text-align: center; grid-column: 1/-1;">Loading...</div>
          </div>
        </div>

        <!-- Charts Grid -->
        <div class="charts-grid">
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📈 Memory Usage (Last 60s)</div>
            </div>
            <div class="chart-container">
              <canvas id="memViewChart" class="chart-canvas"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📊 Swap Usage (Last 60s)</div>
            </div>
            <div class="chart-container">
              <canvas id="swapViewChart" class="chart-canvas"></canvas>
            </div>
          </div>
        </div>

        <!-- Top Processes by Memory -->
        <div class="chart-card" style="margin-top: 24px;">
          <div class="chart-header">
            <div class="chart-title">🧠 Top Processes by Memory</div>
            <button class="btn btn-sm" onclick="loadMemoryProcesses()">Refresh</button>
          </div>
          <table class="process-table">
            <thead>
              <tr>
                <th>PID</th>
                <th>Process</th>
                <th>Memory %</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody id="memViewProcessBody">
              <tr>
                <td colspan="4" style="text-align: center; color: var(--text-muted);">Loading...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div><!-- End view-memory -->

    <!-- VIEW: Disk Details -->
    <div id="view-disk" class="view-section" style="display: none;">
      <div class="dashboard">
        <!-- Disk Overview Stats -->
        <div class="stats-row" style="grid-template-columns: repeat(4, 1fr);">
          <div class="stat-card">
            <div class="stat-label">Total Size</div>
            <div class="stat-value" id="diskViewTotal">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Used Capacity</div>
            <div class="stat-value" id="diskViewUsed">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Available Space</div>
            <div class="stat-value" id="diskViewAvail">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Usage</div>
            <div class="stat-value"><span id="diskViewPercent">--</span><span class="stat-unit">%</span></div>
          </div>
        </div>

        <!-- Charts Grid -->
        <div class="charts-grid">
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📈 Disk I/O (Last 60s)</div>
            </div>
            <div class="chart-container">
              <canvas id="diskIOChart" class="chart-canvas"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📊 Disk Space Usage</div>
            </div>
            <div class="chart-container">
              <canvas id="diskSpaceChart" class="chart-canvas"></canvas>
            </div>
          </div>
        </div>

        <!-- Disk Usage Breakdown -->
        <div class="chart-card" style="margin-top: 24px; margin-bottom: 24px;">
          <div class="chart-header">
            <div class="chart-title">🔢 Disk Space Breakdown</div>
          </div>
          <div id="disk-breakdown-container" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; padding: 16px;">
            <div style="color: var(--text-muted); text-align: center; grid-column: 1/-1;">Loading...</div>
          </div>
        </div>

        <!-- Top Directories by Disk Usage -->
        <div class="chart-card" style="margin-top: 24px;">
          <div class="chart-header">
            <div class="chart-title">📁 Top Directories by Size</div>
            <button class="btn btn-sm" onclick="loadDiskDirectories()">Refresh</button>
          </div>
          <table class="process-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Directory</th>
                <th>Size</th>
                <th>Usage</th>
              </tr>
            </thead>
            <tbody id="diskViewDirBody">
              <tr>
                <td colspan="4" style="text-align: center; color: var(--text-muted);">Loading...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div><!-- End view-disk -->

    <!-- VIEW: Network Monitoring -->
    <div id="view-network" class="view-section" style="display: none;">
      <div class="dashboard">
        <!-- Network Stats Row -->
        <div class="stats-row" style="grid-template-columns: repeat(4, 1fr);">
          <div class="stat-card">
            <div class="stat-label">Total Packets</div>
            <div class="stat-value" id="networkTotalPackets">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Packets/Sec</div>
            <div class="stat-value" id="networkPacketsPerSec">--</div>
          </div>
          <div class="stat-card" style="border-color: var(--warning);">
            <div class="stat-label">🚨 Suspicious</div>
            <div class="stat-value" id="networkSuspiciousCount" style="color: var(--warning);">--</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">External Connections</div>
            <div class="stat-value" id="networkExternalConnections">--</div>
          </div>
        </div>

        <!-- Protocol Breakdown -->
        <div class="chart-card" style="margin-bottom: 24px;">
          <div class="chart-header">
            <div class="chart-title">📊 Protocol Distribution</div>
          </div>
          <div id="protocol-breakdown" style="display: flex; gap: 16px; padding: 16px; flex-wrap: wrap;">
            <div style="color: var(--text-muted);">Loading...</div>
          </div>
        </div>

        <!-- Network Charts -->
        <div class="charts-grid">
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">🌐 Network Traffic</div>
            </div>
            <div class="chart-container">
              <canvas id="networkViewChart" class="chart-canvas"></canvas>
            </div>
          </div>
          <div class="chart-card">
            <div class="chart-header">
              <div class="chart-title">📈 Packets Over Time</div>
            </div>
            <div class="chart-container">
              <canvas id="packetsChart" class="chart-canvas"></canvas>
            </div>
          </div>
        </div>

        <!-- Packet List Table -->
        <div class="chart-card" style="margin-top: 24px;">
          <div class="chart-header">
            <div class="chart-title">📦 Recent Network Packets</div>
            <button class="btn btn-sm" onclick="loadNetworkPackets()">Refresh</button>
          </div>
          <div style="max-height: 400px; overflow-y: auto;">
            <table class="process-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Source IP</th>
                  <th>Dest IP</th>
                  <th>Port</th>
                  <th>Protocol</th>
                  <th>Payload</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="networkPacketBody">
                <tr>
                  <td colspan="7" style="text-align: center; color: var(--text-muted);">Loading packets...</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Sniffer Status -->
        <div style="margin-top: 16px; padding: 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; font-size: 12px; color: var(--text-muted);">
          <span id="snifferStatus">⏳ Checking sniffer status...</span>
        </div>
      </div>
    </div><!-- End view-network -->

    <!-- VIEW: Alerts & Remediation -->
    <div id="view-alerts" class="view-section" style="display: none;">
      <div class="dashboard">
        <!-- Alerts Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
          <h2 style="margin: 0; color: var(--text-primary);">🚨 Active Alerts</h2>
          <button class="btn btn-sm" onclick="loadAlerts()">⟳ Refresh</button>
        </div>

        <!-- Alerts Container -->
        <div id="alertsContainer" style="display: grid; gap: 16px;">
          <div style="text-align: center; padding: 40px; color: var(--text-muted);">
            Loading alerts...
          </div>
        </div>

        <!-- Alert History -->
        <div class="chart-card" style="margin-top: 32px;">
          <div class="chart-header">
            <div class="chart-title">📜 Alert History</div>
          </div>
          <table class="process-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Alert Topic</th>
                <th>Remediation Step</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody id="alertHistoryBody">
              <tr>
                <td colspan="4" style="text-align: center; color: var(--text-muted);">Loading history...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div><!-- End view-alerts -->

  </main>

  <!-- Floating Chat Panel -->
  <div class="chat-panel" id="chatPanel" style="display: none;">
    <div class="chat-header">
      <div class="chat-title">
        <span style="font-size: 18px;">🤖</span>
        AI Infrastructure Agent
      </div>
      <button class="btn btn-sm btn-outline" onclick="toggleChat()">✕</button>
    </div>
    <div class="chat-messages" id="chatMessages">
      <div class="chat-message ai">
        <div class="chat-bubble">
          Welcome! I'm your AI infrastructure agent. Type <strong>/</strong> to see all available commands, or ask me anything about your system.
        </div>
      </div>
    </div>
    <div class="chat-input-wrapper">
      <div class="slash-menu" id="slashMenu"></div>
      <textarea class="chat-input" id="chatInput" placeholder="Type / for commands..." rows="1"></textarea>
      <button class="chat-send" onclick="sendMessage()">→</button>
    </div>
  </div>

  <script>
    // ==========================================
    // DATA STORAGE
    // ==========================================
    // ==========================================
    // THEME HANDLING
    // ==========================================
    function toggleTheme() {
      const root = document.documentElement;
      const current = root.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      // Force chart update to pick up new colors
      if (typeof updateCharts === 'function') updateCharts();
    }
    // Init theme
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    // ==========================================
    // DATA STORAGE
    // ==========================================
    const chartData = {
      cpu: [],
      mem: [],
      net: { in: [], out: [] },
      disk: { read: [], write: [] },
      load: { load1: [], load5: [], load15: [] }
    };
    const maxPoints = 60;

    // ==========================================
    // CHART DRAWING (Pure Canvas, No Library)
    // ==========================================
    function drawChart(canvasId, datasets, options = {}) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      
      const ctx = canvas.getContext('2d');
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * 2;
      canvas.height = rect.height * 2;
      ctx.scale(2, 2);
      
      const width = rect.width;
      const height = rect.height;
      const padding = { top: 20, right: 20, bottom: 30, left: 50 };
      const chartWidth = width - padding.left - padding.right;
      const chartHeight = height - padding.top - padding.bottom;
      
      
      // Get theme colors from body/root where data-theme is set
      const style = getComputedStyle(document.documentElement);
      const bgCard = style.getPropertyValue('--bg-card').trim() || (document.documentElement.getAttribute('data-theme') === 'light' ? '#ffffff' : '#171717');
      const borderColor = style.getPropertyValue('--border').trim() || '#2d2d2d';
      const textMuted = style.getPropertyValue('--text-muted').trim() || '#6b6b6b';
      const textSecondary = style.getPropertyValue('--text-secondary').trim() || '#ababab';

      // Clear
      ctx.fillStyle = bgCard;
      ctx.fillRect(0, 0, width, height);
      
      // Find max value
      let maxVal = options.maxY || 0;
      datasets.forEach(ds => {
        const max = Math.max(...ds.data.filter(v => !isNaN(v)));
        if (max > maxVal) maxVal = max;
      });
      if (maxVal === 0) maxVal = 100;
      maxVal = Math.ceil(maxVal * 1.1);
      
      // Draw grid
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        
        // Y axis labels
        ctx.fillStyle = textMuted;
        ctx.font = '11px JetBrains Mono';
        ctx.textAlign = 'right';
        const val = (maxVal - (maxVal / 4) * i).toFixed(0);
        ctx.fillText(val + (options.unit || ''), padding.left - 8, y + 4);
      }
      
      // Draw lines
      datasets.forEach(ds => {
        if (ds.data.length < 2) return;
        
        ctx.strokeStyle = ds.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        
        // Dynamic step based on data length to ensure it fills width
        const points = ds.data.length > 1 ? ds.data.length : maxPoints;
        const step = chartWidth / (points - 1);

        ds.data.forEach((val, i) => {
          const x = padding.left + i * step;
          const y = padding.top + chartHeight - (val / maxVal) * chartHeight;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
        
        // Fill gradient
        const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
        gradient.addColorStop(0, ds.color + '40');
        gradient.addColorStop(1, ds.color + '00');
        
        ctx.fillStyle = gradient;
        ctx.lineTo(padding.left + (ds.data.length - 1) * step, height - padding.bottom);
        ctx.lineTo(padding.left, height - padding.bottom);
        ctx.closePath();
        ctx.fill();
      });
      
      // Legend
      if (datasets.length > 1) {
        let legendX = padding.left;
        datasets.forEach(ds => {
          ctx.fillStyle = ds.color;
          ctx.fillRect(legendX, height - 15, 12, 3);
          ctx.fillStyle = textSecondary;
          ctx.font = '11px Inter';
          ctx.textAlign = 'left';
          ctx.fillText(ds.label, legendX + 16, height - 11);
          legendX += ctx.measureText(ds.label).width + 36;
        });
      }
    }

    // ==========================================
    // DATA FETCHING
    // ==========================================
    async function fetchCPU() {
      try {
        const res = await fetch('/api/chart/system.cpu?after=-60&points=60');
        const data = await res.json();
        if (data.data) {
          chartData.cpu = data.data.map(row => {
            const values = row.slice(1);
            return values.reduce((a, b) => a + b, 0);
          }).reverse();
          
          const latest = chartData.cpu[chartData.cpu.length - 1] || 0;
          document.getElementById('cpuStat').textContent = latest.toFixed(1);
        }
      }catch (e) {}
    }

    async function fetchMemory() {
      try {
        const res = await fetch('/api/chart/system.ram?after=-60&points=60');
        const data = await res.json();
        if (data.data) {
          chartData.mem = data.data.map(row => {
            const values = row.slice(1);
            const total = values.reduce((a, b) => a + b, 0);
            const used = values[1] || 0;
            return total > 0 ? (used / total * 100) : 0;
          }).reverse();
          
          const latest = chartData.mem[chartData.mem.length - 1] || 0;
          document.getElementById('memStat').textContent = latest.toFixed(1);
        }
      }catch (e) {}
    }

    async function fetchNetwork() {
      try {
        const res = await fetch('/api/chart/system.net?after=-60&points=60');
        const data = await res.json();
        if (data.data) {
          chartData.net.in = data.data.map(row => Math.abs(row[1] || 0)).reverse();
          chartData.net.out = data.data.map(row => Math.abs(row[2] || 0)).reverse();
          
          const latestIn = chartData.net.in[chartData.net.in.length - 1] || 0;
          const latestOut = chartData.net.out[chartData.net.out.length - 1] || 0;
          document.getElementById('netInStat').textContent = formatBytes(latestIn * 1024);
          document.getElementById('netOutStat').textContent = formatBytes(latestOut * 1024);
        }
      }catch (e) {}
    }

    async function fetchDiskIO() {
      try {
        const res = await fetch('/api/chart/system.io?after=-60&points=60');
        const data = await res.json();
        if (data.data) {
          chartData.disk.read = data.data.map(row => Math.abs(row[1] || 0)).reverse();
          chartData.disk.write = data.data.map(row => Math.abs(row[2] || 0)).reverse();
          
          const latestRead = chartData.disk.read[chartData.disk.read.length - 1] || 0;
          const latestWrite = chartData.disk.write[chartData.disk.write.length - 1] || 0;
          document.getElementById('diskIOStat').textContent = formatBytes((latestRead + latestWrite) * 1024);
        }
      }catch (e) {}
    }

    async function fetchLoad() {
      try {
        const res = await fetch('/api/chart/system.load?after=-60&points=60');
        const data = await res.json();
        if (data.data) {
          chartData.load.load1 = data.data.map(row => row[1] || 0).reverse();
          chartData.load.load5 = data.data.map(row => row[2] || 0).reverse();
          chartData.load.load15 = data.data.map(row => row[3] || 0).reverse();
          
          const latest = chartData.load.load1[chartData.load.load1.length - 1] || 0;
          document.getElementById('loadStat').textContent = latest.toFixed(2);
        }
      }catch (e) {}
    }

    async function fetchAlerts() {
      const list = document.getElementById('alertsList');
      try {
        const res = await fetch('/api/alerts');
        if (!res.ok) throw new Error('API error: ' + res.status);
        
        const data = await res.json();
        const alerts = Object.values(data.alarms || {});
        
        document.getElementById('alertsCount').textContent = alerts.length;
        
        if (alerts.length === 0) {
          list.innerHTML = '<div class="alert-row" style="justify-content: center; color: var(--accent);">✓ All systems normal</div>';
        }else {
          list.innerHTML = alerts.map(a => \`
            <div class="alert-row">
              <div class="alert-severity \${a.status === 'CRITICAL' ? 'critical' : 'warning'}"></div>
              <div class="alert-content">
                <div class="alert-name">\${a.name}</div>
                <div class="alert-meta">\${a.chart}• \${a.status}</div>
              </div>
              <button class="btn btn-sm" onclick="diagnoseAlert('\${a.name}')">Diagnose</button>
            </div>
          \`).join('');
        }
      }catch (e) {
        console.error('Alerts fetch error:', e);
        list.innerHTML = '<div class="alert-row" style="justify-content: center; color: var(--error);">⚠ Failed to load alerts</div>';
        document.getElementById('alertsCount').textContent = '?';
      }
    }

    async function fetchInfo() {
      try {
        const res = await fetch('/api/info');
        const data = await res.json();
        
        document.getElementById('netdataStatus').textContent = 'Connected';
        document.getElementById('hostnameValue').textContent = data.hostname || '--';
        
        const uptime = data.host?.uptime || 0;
        const hours = Math.floor(uptime / 3600);
        const mins = Math.floor((uptime % 3600) / 60);
        document.getElementById('uptimeValue').textContent = \`\${hours}h \${mins}m\`;
      }catch (e) {
        document.getElementById('netdataStatus').textContent = 'Disconnected';
      }
    }

    async function fetchCharts() {
      try {
        const res = await fetch('/api/charts');
        const data = await res.json();
        const count = Object.keys(data.charts || {}).length;
        document.getElementById('chartsCount').textContent = count;
      }catch (e) {}
    }

    async function fetchProcesses() {
      try {
        const res = await fetch('/api/chart/apps.cpu?after=-1&points=1');
        const data = await res.json();
        if (data.data && data.data[0]) {
          const labels = data.labels.slice(1);
          const values = data.data[0].slice(1);
          const processes = labels.map((name, i) => ({ name, cpu: values[i] || 0 }))
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 8);
          
          const tbody = document.getElementById('processBody');
          tbody.innerHTML = processes.map(p => \`
            <tr>
              <td class="process-name">\${p.name}</td>
              <td>\${p.cpu.toFixed(1)}%</td>
              <td>
                <div class="process-bar">
                  <div class="process-bar-fill" style="width: \${Math.min(p.cpu, 100)}%; background: \${p.cpu > 50 ? 'var(--warning)' : 'var(--accent)'}"></div>
                </div>
              </td>
            </tr>
          \`).join('');
        }
      }catch (e) {}
    }

    // ==========================================
    // CHAT FUNCTIONALITY
    // ==========================================
    const mcpTools = [
      { cmd: '/cpu', desc: 'CPU usage breakdown', query: 'What is my CPU usage?' },
      { cmd: '/memory', desc: 'Memory/RAM usage', query: 'Show me memory usage' },
      { cmd: '/disk', desc: 'Disk space usage', query: 'Check disk space' },
      { cmd: '/diskio', desc: 'Disk I/O stats', query: 'Show disk I/O stats' },
      { cmd: '/network', desc: 'Network traffic', query: 'Show network traffic' },
      { cmd: '/alerts', desc: 'Active alerts', query: 'What alerts are active?' },
      { cmd: '/processes', desc: 'Top CPU processes', query: 'What processes are using the most CPU?' },
      { cmd: '/load', desc: 'System load', query: 'What is the system load?' },
      { cmd: '/system', desc: 'System info', query: 'Show system information' },
      { cmd: '/investigate', desc: 'Full investigation', query: 'Investigate the current system state thoroughly' },
      { cmd: '/diagnose', desc: 'Diagnose alerts', query: 'Check active alerts and diagnose them' },
    ];

    let selectedIdx = 0;
    let filtered = [];

    function toggleChat() {
      const panel = document.getElementById('chatPanel');
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    }

    const chatInput = document.getElementById('chatInput');
    const slashMenu = document.getElementById('slashMenu');

    chatInput.addEventListener('input', () => {
      const val = chatInput.value;
      if (val.startsWith('/')) {
        const q = val.slice(1).toLowerCase();
        filtered = mcpTools.filter(t => t.cmd.includes(q) || t.desc.toLowerCase().includes(q));
        if (filtered.length > 0) {
          slashMenu.innerHTML = \`
            <div class="slash-header">MCP Commands</div>
            \${filtered.map((t, i) => \`
              <div class="slash-item \${i === selectedIdx ? 'selected' : ''}" data-i="\${i}">
                <span class="slash-cmd">\${t.cmd}</span>
                <span class="slash-desc">\${t.desc}</span>
              </div>
            \`).join('')}
          \`;
          slashMenu.classList.add('visible');
          slashMenu.querySelectorAll('.slash-item').forEach(el => {
            el.onclick = () => selectSlash(filtered[parseInt(el.dataset.i)]);
          });
        }else {
          slashMenu.classList.remove('visible');
        }
      }else {
        slashMenu.classList.remove('visible');
        selectedIdx = 0;
      }
    });

    chatInput.addEventListener('keydown', e => {
      if (slashMenu.classList.contains('visible')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedIdx = Math.min(selectedIdx + 1, filtered.length - 1);
          chatInput.dispatchEvent(new Event('input'));
        }else if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIdx = Math.max(selectedIdx - 1, 0);
          chatInput.dispatchEvent(new Event('input'));
        }else if (e.key === 'Enter' || e.key === 'Tab') {
          if (filtered.length > 0) {
            e.preventDefault();
            selectSlash(filtered[selectedIdx]);
          }
        }else if (e.key === 'Escape') {
          slashMenu.classList.remove('visible');
        }
      }else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    function selectSlash(tool) {
      chatInput.value = tool.query;
      slashMenu.classList.remove('visible');
      selectedIdx = 0;
      chatInput.focus();
    }

    async function sendMessage() {
      const text = chatInput.value.trim();
      if (!text) return;
      
      chatInput.value = '';
      slashMenu.classList.remove('visible');
      
      addChatMessage(text, true);
      const typingId = addTyping();
      
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text })
        });
        const data = await res.json();
        removeTyping(typingId);
        
        let content = data.response || 'No response';
        if (data.tools_used?.length > 0) {
          content = '<div style="margin-bottom: 8px; font-size: 11px; color: var(--text-muted);">Tools: ' + data.tools_used.join(', ') + '</div>' + content;
        }
        addChatMessage(content, false);
      }catch (e) {
        removeTyping(typingId);
        addChatMessage('Error connecting to AI Brain', false);
      }
    }

    function addChatMessage(content, isUser) {
      const msgs = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.className = 'chat-message ' + (isUser ? 'user' : 'ai');
      div.innerHTML = \`<div class="chat-bubble">\${content.replace(/\\n/g, '<br>')}</div>\`;
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function addTyping() {
      const id = 'typing-' + Date.now();
      const msgs = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.className = 'chat-message ai';
      div.id = id;
      div.innerHTML = '<div class="chat-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>';
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      return id;
    }

    function removeTyping(id) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }

    function diagnoseAlert(name) {
      chatInput.value = 'Diagnose the ' + name + ' alert';
      document.getElementById('chatPanel').style.display = 'flex';
      sendMessage();
    }

    // ==========================================
    // UTILITIES
    // ==========================================
    function formatBytes(bytes) {
      if (bytes < 1024) return bytes.toFixed(0) + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function refreshAll() {
      // Show loading states
      document.getElementById('alertsList').innerHTML = '<div class="alert-row" style="justify-content: center; color: var(--text-muted);">Refreshing...</div>';
      document.getElementById('processBody').innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Refreshing...</td></tr>';
      
      fetchCPU();
      fetchMemory();
      fetchNetwork();
      fetchDiskIO();
      fetchLoad();
      fetchAlerts();
      fetchProcesses();
      fetchInfo();
      fetchCharts();
    }

    function refreshAlerts() {
      const list = document.getElementById('alertsList');
      list.innerHTML = '<div class="alert-row" style="justify-content: center; color: var(--text-muted);">Refreshing...</div>';
      fetchAlerts();
    }

    function refreshProcesses() {
      const tbody = document.getElementById('processBody');
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Refreshing...</td></tr>';
      fetchProcesses();
    }
    
    // ==========================================
    // HITL: PENDING ACTIONS
    // ==========================================
    async function refreshPendingActions() {
      try {
        const res = await fetch('/api/pending-actions');
        const data = await res.json();
        const actions = data.actions || [];
        
        document.getElementById('pendingCount').textContent = actions.length;
        const container = document.getElementById('pendingActionsList');
        
        if (actions.length === 0) {
          container.innerHTML = '<div class="alert-row" style="justify-content: center; color: var(--text-muted);">No pending actions - all clear! ✓</div>';
        }else {
          container.innerHTML = actions.map(a => \`
            <div style="padding: 16px; border-bottom: 1px solid var(--border);">
              <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                <div>
                  <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
                    \${a.action_type.replace('_', ' ').toUpperCase()}
                  </div>
                  <div style="font-size: 12px; color: var(--text-muted);">
                    Target: \${a.target}| Severity: <span style="color: \${a.severity === 'CRITICAL' ? 'var(--error)' : a.severity === 'HIGH' ? 'var(--warning)' : 'var(--accent)'};">\${a.severity}</span>
                  </div>
                </div>
                <div style="font-size: 11px; color: var(--text-muted);">
                  ID: \${String(a.id).slice(0, 8)}
                </div>
              </div>
              <div style="background: var(--bg-secondary); padding: 12px; border-radius: 8px; margin-bottom: 12px; font-size: 13px;">
                <div style="margin-bottom: 8px;"><strong>Description:</strong> \${a.description}</div>
                <div style="margin-bottom: 8px;"><strong>Impact:</strong> \${a.impact || 'Unknown'}</div>
                <div><strong>Rollback:</strong> \${a.rollback_plan || 'Manual intervention'}</div>
              </div>
              <div style="display: flex; gap: 8px;">
                <button onclick="approveAction('\${a.id}')" class="btn" style="background: var(--accent); flex: 1;">
                  ✓ Approve
                </button>
                <button onclick="rejectAction('\${a.id}')" class="btn btn-outline" style="color: var(--error); border-color: var(--error); flex: 1;">
                  ✕ Reject
                </button>
              </div>
            </div>
          \`).join('');
        }
      }catch (e) {
        console.error('Pending actions error:', e);
      }
    }
    
    async function approveAction(actionId) {
      try {
        const res = await fetch(\`/api/actions/\${actionId}/approve\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_id: actionId, decision: 'approve', approved_by: 'admin' })
        });
        const data = await res.json();
        
        // Show success notification
        addChatMessage('✅ Action approved: ' + data.message, false);
        document.getElementById('chatPanel').style.display = 'flex';
        
        // Refresh pending actions
        refreshPendingActions();
      }catch (e) {
        console.error('Approval error:', e);
      }
    }
    
    async function rejectAction(actionId) {
      try {
        const res = await fetch(\`/api/actions/\${actionId}/approve\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action_id: actionId, decision: 'reject', approved_by: 'admin' })
        });
        const data = await res.json();
        
        addChatMessage('❌ Action rejected: ' + data.message, false);
        document.getElementById('chatPanel').style.display = 'flex';
        refreshPendingActions();
      }catch (e) {
        console.error('Rejection error:', e);
      }
    }
    
    // WebSocket for real-time HITL updates
    function connectWebSocket() {
      try {
        const ws = new WebSocket('ws://localhost:8000/ws');
        ws.onopen = () => console.log('HITL WebSocket connected');
        ws.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'pending_action') {
            refreshPendingActions();
            // Flash notification
            document.getElementById('pendingCount').style.animation = 'pulse 0.5s 3';
          }else if (data.type === 'action_resolved') {
            refreshPendingActions();
          }
        };
        ws.onclose = () => setTimeout(connectWebSocket, 3001);
      }catch (e) {
        console.log('WebSocket not available');
      }
    }
    connectWebSocket();
    
    // Initial fetch
    refreshPendingActions();
    setInterval(refreshPendingActions, 5000);


    // ==========================================
    // MAIN LOOP
    // ==========================================
    async function updateCharts() {
      drawChart('cpuChart', [
        { label: 'CPU %', data: chartData.cpu, color: '#10a37f' }
      ], { unit: '%', maxY: 100 });
      
      drawChart('memChart', [
        { label: 'Memory %', data: chartData.mem, color: '#43a9ff' }
      ], { unit: '%', maxY: 100 });
      
      drawChart('netChart', [
        { label: 'In', data: chartData.net.in, color: '#10a37f' },
        { label: 'Out', data: chartData.net.out, color: '#f5a623' }
      ], { unit: ' KB/s' });
      
      drawChart('diskChart', [
        { label: 'Read', data: chartData.disk.read, color: '#a855f7' },
        { label: 'Write', data: chartData.disk.write, color: '#ff4d4f' }
      ], { unit: ' KB/s' });
      
      drawChart('loadChart', [
        { label: '1m', data: chartData.load.load1, color: '#10a37f' },
        { label: '5m', data: chartData.load.load5, color: '#43a9ff' },
        { label: '15m', data: chartData.load.load15, color: '#f5a623' }
      ]);
    }

    async function mainLoop() {
      await Promise.all([fetchCPU(), fetchMemory(), fetchNetwork(), fetchDiskIO(), fetchLoad()]);
      updateCharts();
    }

    // Initialize
    refreshAll();
    mainLoop();
    setInterval(mainLoop, 1000);
    setInterval(fetchAlerts, 5000);
    setInterval(fetchProcesses, 3001);

    // ==========================================
    // VIEW SWITCHING
    // ==========================================
    let currentView = 'overview';
    
    function showTab(viewId) {
      // Hide all views
      document.querySelectorAll('.view-section').forEach(el => el.style.display = 'none');
      
      // Show selected view
      const viewEl = document.getElementById('view-' + viewId);
      if (viewEl) viewEl.style.display = 'flex';
      
      // Update nav active state
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      if (event && event.target) {
        event.target.closest('.nav-item').classList.add('active');
      }
      
      currentView = viewId;
      
      // Load view-specific data
      if (viewId === 'cpu') loadCPUView();
      if (viewId === 'memory') loadMemoryView();
      if (viewId === 'disk') loadDiskView();
      if (viewId === 'network') loadNetworkView();
      if (viewId === 'alerts') loadAlerts();
    }

    // ==========================================
    // CPU VIEW DATA LOADING
    // ==========================================
    let cpuViewData = { cpu: [] };
    let cpuCoresList = [];
    
    async function loadCPUView() {
      // Load aggregate CPU data
      try {
        const cpuRes = await fetch('/api/chart/system.cpu?after=-60&points=60');
        const cpuData = await cpuRes.json();
        if (cpuData.data) {
          cpuViewData.cpu = cpuData.data.map(row => {
            const values = row.slice(1);
            return values.reduce((a, b) => a + b, 0);
          }).reverse();
          
          const latest = cpuViewData.cpu[cpuViewData.cpu.length - 1] || 0;
          document.getElementById('cpuViewTotal').textContent = latest.toFixed(1);
          
          // Draw CPU chart
          drawChart('cpuViewChart', [
            { label: 'CPU %', data: cpuViewData.cpu, color: '#10a37f' }
          ], { unit: '%', maxY: 100 });
        }
      }catch (e) { console.error('CPU view fetch error:', e); }
      
      // Load system load (stats + chart)
      try {
        const loadRes = await fetch('/api/chart/system.load?after=-60&points=60');
        const loadData = await loadRes.json();
        if (loadData.data && loadData.data.length > 0) {
          // Update stats from latest value
          const latest = loadData.data[0];
          document.getElementById('cpuViewLoad1').textContent = (latest[1] || 0).toFixed(2);
          document.getElementById('cpuViewLoad5').textContent = (latest[2] || 0).toFixed(2);
          document.getElementById('cpuViewLoad15').textContent = (latest[3] || 0).toFixed(2);
          
          // Draw load chart
          const load1 = loadData.data.map(row => row[1] || 0).reverse();
          const load5 = loadData.data.map(row => row[2] || 0).reverse();
          const load15 = loadData.data.map(row => row[3] || 0).reverse();
          
          drawChart('cpuLoadChart', [
            { label: '1m', data: load1, color: '#10a37f' },
            { label: '5m', data: load5, color: '#43a9ff' },
            { label: '15m', data: load15, color: '#f5a623' }
          ]);
        }
      }catch (e) {}
      
      // Load per-core data
      await loadCPUCores();
      
      // Load processes
      await loadCPUProcesses();
    }
    
    async function loadCPUCores() {
      const container = document.getElementById('cpu-cores-container');
      if (!container) return;
      
      try {
        // Use system.cpu breakdown as CPU components
        const cpuRes = await fetch('/api/chart/system.cpu?after=-1&points=1');
        const cpuData = await cpuRes.json();
        
        if (!cpuData.labels || !cpuData.data || !cpuData.data[0]) {
          container.innerHTML = '<div style="color: var(--text-muted); text-align: center; grid-column: 1/-1;">No CPU component data</div>';
          return;
        }
        
        const labels = cpuData.labels.slice(1); // Skip 'time'
        const values = cpuData.data[0].slice(1);
        
        container.innerHTML = '';
        
        for (var i = 0; i < labels.length; i++) {
          var label = labels[i];
          var value = values[i] || 0;
          
          if (value < 0.01) continue; // Skip zero values
          
          var card = document.createElement('div');
          card.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 12px; text-align: center;';
          card.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px; text-transform: capitalize;">' + label + '</div><div style="font-size: 20px; font-weight: 600; color: var(--text-primary);">' + value.toFixed(1) + '%</div>';
          container.appendChild(card);
        }
        
        if (container.children.length === 0) {
          container.innerHTML = '<div style="color: var(--text-muted); text-align: center; grid-column: 1/-1;">CPU idle</div>';
        }
      }catch (e) {
        container.innerHTML = '<div style="color: var(--error); text-align: center; grid-column: 1/-1;">Error loading CPU data</div>';
      }
    }
    
    async function loadCPUProcesses() {
      const tbody = document.getElementById('cpuViewProcessBody');
      if (!tbody) return;
      
      try {
        // Use ps-based API endpoint for actual process data
        const res = await fetch('/api/processes');
        const data = await res.json();
        
        if (data.processes && data.processes.length > 0) {
          tbody.innerHTML = data.processes.map(function(p) {
            var barWidth = Math.min(p.cpu, 100);
            var barColor = p.cpu > 50 ? 'var(--warning)' : 'var(--accent)';
            var cmdDisplay = p.command.length > 30 ? p.command.substring(0, 30) + '...' : p.command;
            return '<tr><td style="font-family: JetBrains Mono, monospace; color: var(--accent);">' + p.pid + '</td><td class="process-name">' + cmdDisplay + '</td><td>' + p.cpu.toFixed(1) + '%</td><td><div class="process-bar"><div class="process-bar-fill" style="width: ' + barWidth + '%; background: ' + barColor + '"></div></div></td></tr>';
          }).join('');
        }else {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No process data</td></tr>';
        }
      }catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--error);">Error loading processes</td></tr>';
      }
    }
    
    // Auto-refresh CPU view if active
    setInterval(() => {
      if (currentView === 'cpu') loadCPUView();
    }, 2000);

    // ==========================================
    // MEMORY VIEW DATA LOADING
    // ==========================================
    let memViewData = { used: [], swap: [] };
    
    async function loadMemoryView() {
      // Load memory stats and chart
      try {
        const memRes = await fetch('/api/chart/system.ram?after=-60&points=60');
        const memData = await memRes.json();
        if (memData.data && memData.labels) {
          // Calculate used memory percentage over time
          const labels = memData.labels.slice(1);
          const usedData = [];
          let totalMem = 0;
          let usedMem = 0;
          let freeMem = 0;
          let cachedMem = 0;
          let buffersMem = 0;
          
          memData.data.forEach(row => {
            const values = row.slice(1);
            const total = values.reduce((a, b) => a + Math.abs(b || 0), 0);
            // Find used memory (index varies, typically position 1 or look for 'used' label)
            const usedIdx = labels.findIndex(l => l.toLowerCase() === 'used');
            const freeIdx = labels.findIndex(l => l.toLowerCase() === 'free');
            const cachedIdx = labels.findIndex(l => l.toLowerCase() === 'cached');
            const buffersIdx = labels.findIndex(l => l.toLowerCase() === 'buffers');
            
            const used = Math.abs(values[usedIdx] || 0);
            const pct = total > 0 ? (used / total * 100) : 0;
            usedData.push(pct);
            
            // Store latest values for stats
            totalMem = total;
            usedMem = used;
            freeMem = Math.abs(values[freeIdx] || 0);
            cachedMem = Math.abs(values[cachedIdx] || 0);
            buffersMem = Math.abs(values[buffersIdx] || 0);
          });
          
          memViewData.used = usedData.reverse();
          
          // Update stats
          const latestPct = memViewData.used[memViewData.used.length - 1] || 0;
          document.getElementById('memViewUsed').textContent = latestPct.toFixed(1);
          document.getElementById('memViewTotal').textContent = formatBytes(totalMem * 1024 * 1024);
          
          // Draw memory chart
          drawChart('memViewChart', [
            { label: 'Used %', data: memViewData.used, color: '#43a9ff' }
          ], { unit: '%', maxY: 100 });
          
          // Update breakdown
          updateMemoryBreakdown(labels, memData.data[0] ? memData.data[0].slice(1) : []);
        }
      } catch (e) { console.error('Memory view fetch error:', e); }
      
      // Load swap stats
      try {
        const swapRes = await fetch('/api/chart/mem.swap?after=-60&points=60');
        const swapData = await swapRes.json();
        if (swapData.data && swapData.labels) {
          const labels = swapData.labels.slice(1);
          const usedData = [];
          let totalSwap = 0;
          let usedSwap = 0;
          
          swapData.data.forEach(row => {
            const values = row.slice(1);
            const total = values.reduce((a, b) => a + Math.abs(b || 0), 0);
            const usedIdx = labels.findIndex(l => l.toLowerCase() === 'used');
            // Use proper null check - 0 is a valid value, not falsy here
            const used = usedIdx >= 0 && values[usedIdx] !== undefined ? Math.abs(values[usedIdx]) : 0;
            const pct = total > 0 ? (used / total * 100) : 0;
            usedData.push(pct);
            totalSwap = total;
            usedSwap = used;
          });
          
          memViewData.swap = usedData.reverse();
          
          // Update stats
          const latestSwapPct = memViewData.swap[memViewData.swap.length - 1] || 0;
          document.getElementById('memViewSwapUsed').textContent = latestSwapPct.toFixed(1);
          document.getElementById('memViewSwapTotal').textContent = formatBytes(totalSwap * 1024 * 1024);
          
          // Draw swap chart
          drawChart('swapViewChart', [
            { label: 'Swap %', data: memViewData.swap, color: '#f5a623' }
          ], { unit: '%', maxY: 100 });
        }
      } catch (e) { console.error('Swap view fetch error:', e); }
      
      // Load top processes by memory
      await loadMemoryProcesses();
    }
    
    function formatBytes(bytes) {
      if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
      if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1024).toFixed(1) + ' KB';
    }
    
    function updateMemoryBreakdown(labels, values) {
      const container = document.getElementById('memory-breakdown-container');
      if (!container) return;
      
      const colors = {
        'used': '#ef4444',
        'free': '#10a37f',
        'cached': '#43a9ff',
        'buffers': '#a855f7',
        'available': '#22c55e'
      };
      
      container.innerHTML = '';
      
      for (var i = 0; i < labels.length; i++) {
        var label = labels[i];
        var value = Math.abs(values[i] || 0);
        
        if (value < 1) continue; // Skip very small values
        
        var color = colors[label.toLowerCase()] || '#666';
        var card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 12px; text-align: center;';
        card.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px; text-transform: capitalize;">' + label + '</div><div style="font-size: 18px; font-weight: 600; color: ' + color + ';">' + formatBytes(value * 1024 * 1024) + '</div>';
        container.appendChild(card);
      }
      
      if (container.children.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); text-align: center; grid-column: 1/-1;">No memory data</div>';
      }
    }
    
    async function loadMemoryProcesses() {
      const tbody = document.getElementById('memViewProcessBody');
      if (!tbody) return;
      
      try {
        const res = await fetch('/api/processes?sort=memory');
        const data = await res.json();
        
        if (data.processes && data.processes.length > 0) {
          // Sort by memory and take top 10
          const sorted = data.processes.sort((a, b) => (b.memory || 0) - (a.memory || 0)).slice(0, 10);
          tbody.innerHTML = sorted.map(function(p) {
            var memPct = p.memory || 0;
            var barWidth = Math.min(memPct, 100);
            var barColor = memPct > 50 ? 'var(--warning)' : '#43a9ff';
            var cmdDisplay = p.command.length > 30 ? p.command.substring(0, 30) + '...' : p.command;
            return '<tr><td style="font-family: JetBrains Mono, monospace; color: var(--accent);">' + p.pid + '</td><td class="process-name">' + cmdDisplay + '</td><td>' + memPct.toFixed(1) + '%</td><td><div class="process-bar"><div class="process-bar-fill" style="width: ' + barWidth + '%; background: ' + barColor + '"></div></div></td></tr>';
          }).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No process data</td></tr>';
        }
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--error);">Error loading processes</td></tr>';
      }
    }
    
    // Auto-refresh Memory view if active
    setInterval(() => {
      if (currentView === 'memory') loadMemoryView();
    }, 2000);

    // ==========================================
    // DISK VIEW DATA LOADING
    // ==========================================
    let diskViewData = { reads: [], writes: [], space: [] };
    
    async function loadDiskView() {
      // Load disk space stats
      try {
        const spaceRes = await fetch('/api/chart/disk_space.%2F?after=-60&points=60');
        const spaceData = await spaceRes.json();
        if (spaceData.data && spaceData.labels) {
          const labels = spaceData.labels.slice(1); // ['avail', 'used', 'reserved for root']
          const latest = spaceData.data[0]?.slice(1) || [];
          
          const availIdx = labels.findIndex(l => l.toLowerCase().includes('avail'));
          const usedIdx = labels.findIndex(l => l.toLowerCase() === 'used');
          const reservedIdx = labels.findIndex(l => l.toLowerCase().includes('reserved'));
          
          const avail = availIdx >= 0 ? Math.abs(latest[availIdx]) : 0;
          const used = usedIdx >= 0 ? Math.abs(latest[usedIdx]) : 0;
          const reserved = reservedIdx >= 0 ? Math.abs(latest[reservedIdx]) : 0;
          const total = avail + used + reserved;
          const pct = total > 0 ? (used / total * 100) : 0;
          
          // Update stats
          document.getElementById('diskViewTotal').textContent = formatBytes(total * 1024 * 1024 * 1024);
          document.getElementById('diskViewUsed').textContent = formatBytes(used * 1024 * 1024 * 1024);
          document.getElementById('diskViewAvail').textContent = formatBytes(avail * 1024 * 1024 * 1024);
          document.getElementById('diskViewPercent').textContent = pct.toFixed(1);
          
          // Update breakdown
          updateDiskBreakdown(labels, latest);
          
          // Draw space usage chart over time
          const usedHistory = spaceData.data.map(row => {
            const vals = row.slice(1);
            const u = usedIdx >= 0 ? Math.abs(vals[usedIdx]) : 0;
            return u;
          }).reverse();
          
          diskViewData.space = usedHistory;
          drawChart('diskSpaceChart', [
            { label: 'Used (GB)', data: usedHistory, color: '#ef4444' }
          ], { unit: ' GB' });
        }
      } catch (e) { console.error('Disk space fetch error:', e); }
      
      // Load disk I/O stats
      try {
        const ioRes = await fetch('/api/chart/system.io?after=-60&points=60');
        const ioData = await ioRes.json();
        if (ioData.data && ioData.labels) {
          const labels = ioData.labels.slice(1);
          const readsIdx = labels.findIndex(l => l.toLowerCase().includes('read'));
          const writesIdx = labels.findIndex(l => l.toLowerCase().includes('write'));
          
          const reads = ioData.data.map(row => {
            const val = row.slice(1)[readsIdx] || 0;
            return Math.abs(val);
          }).reverse();
          
          const writes = ioData.data.map(row => {
            const val = row.slice(1)[writesIdx] || 0;
            return Math.abs(val);
          }).reverse();
          
          diskViewData.reads = reads;
          diskViewData.writes = writes;
          
          drawChart('diskIOChart', [
            { label: 'Reads', data: reads, color: '#10a37f' },
            { label: 'Writes', data: writes, color: '#f5a623' }
          ], { unit: ' KB/s' });
        }
      } catch (e) { console.error('Disk IO fetch error:', e); }
      
      // Load top directories
      await loadDiskDirectories();
    }
    
    function updateDiskBreakdown(labels, values) {
      const container = document.getElementById('disk-breakdown-container');
      if (!container) return;
      
      const colors = {
        'avail': '#10a37f',
        'used': '#ef4444',
        'reserved for root': '#f5a623',
        'reserved': '#f5a623'
      };
      
      container.innerHTML = '';
      
      for (var i = 0; i < labels.length; i++) {
        var label = labels[i];
        var value = Math.abs(values[i] || 0);
        
        if (value < 0.01) continue;
        
        var colorKey = label.toLowerCase();
        var color = colors[colorKey] || '#666';
        for (var key in colors) {
          if (colorKey.includes(key)) { color = colors[key]; break; }
        }
        
        var card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 12px; text-align: center;';
        card.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px; text-transform: capitalize;">' + label + '</div><div style="font-size: 18px; font-weight: 600; color: ' + color + ';">' + formatBytes(value * 1024 * 1024 * 1024) + '</div>';
        container.appendChild(card);
      }
      
      if (container.children.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); text-align: center; grid-column: 1/-1;">No disk data</div>';
      }
    }
    
    async function loadDiskDirectories() {
      const tbody = document.getElementById('diskViewDirBody');
      if (!tbody) return;
      
      try {
        const res = await fetch('/api/disk-usage');
        const data = await res.json();
        
        if (data.directories && data.directories.length > 0) {
          tbody.innerHTML = data.directories.map(function(d, idx) {
            var barWidth = parseFloat(d.percent) || 0;
            var barColor = barWidth > 80 ? 'var(--error)' : barWidth > 50 ? 'var(--warning)' : 'var(--accent)';
            var pathDisplay = d.path.length > 40 ? '...' + d.path.substring(d.path.length - 37) : d.path;
            return '<tr><td style="font-family: JetBrains Mono, monospace; color: var(--text-muted);">' + (idx + 1) + '</td><td class="process-name" title="' + d.path + '">' + pathDisplay + '</td><td style="font-family: JetBrains Mono, monospace;">' + d.size + '</td><td><div class="process-bar"><div class="process-bar-fill" style="width: ' + barWidth + '%; background: ' + barColor + '"></div></div></td></tr>';
          }).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No directory data</td></tr>';
        }
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--error);">Error loading directories</td></tr>';
      }
    }
    
    // Auto-refresh Disk view if active
    setInterval(() => {
      if (currentView === 'disk') loadDiskView();
    }, 5000); // Disk is slower to update

    // ==========================================
    // NETWORK VIEW DATA LOADING
    // ==========================================
    let networkPacketsHistory = [];
    
    async function loadNetworkView() {
      // Load network stats
      await loadNetworkStats();
      // Load packets
      await loadNetworkPackets();
      // Draw network traffic chart (reuse existing data)
      drawChart('networkViewChart', [
        { label: 'In', data: chartData.net.in, color: '#10a37f' },
        { label: 'Out', data: chartData.net.out, color: '#f5a623' }
      ], { unit: ' KB/s' });
    }
    
    async function loadNetworkStats() {
      try {
        const res = await fetch('/api/network/stats');
        const stats = await res.json();
        
        document.getElementById('networkTotalPackets').textContent = stats.total_packets || 0;
        document.getElementById('networkPacketsPerSec').textContent = (stats.packets_per_second || 0).toFixed(1);
        document.getElementById('networkSuspiciousCount').textContent = stats.suspicious_count || 0;
        document.getElementById('networkExternalConnections').textContent = stats.external_connections || 0;
        
        // Update protocol breakdown
        const protocolContainer = document.getElementById('protocol-breakdown');
        if (protocolContainer) {
          const protocols = stats.protocols || {};
          if (Object.keys(protocols).length > 0) {
            const colors = { TCP: '#10a37f', UDP: '#43a9ff', ICMP: '#f5a623', OTHER: '#a855f7' };
            protocolContainer.innerHTML = Object.entries(protocols).map(function([proto, count]) {
              const color = colors[proto] || '#666';
              return '<div style="background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; padding: 12px 20px; text-align: center;"><div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">' + proto + '</div><div style="font-size: 20px; font-weight: 600; color: ' + color + ';">' + count + '</div></div>';
            }).join('');
          } else {
            protocolContainer.innerHTML = '<div style="color: var(--text-muted);">No packets captured</div>';
          }
        }
        
        // Update sniffer status
        const statusEl = document.getElementById('snifferStatus');
        if (statusEl) {
          if (!stats.scapy_available) {
            statusEl.innerHTML = '⚠️ Scapy not installed - packet sniffing disabled';
            statusEl.style.color = 'var(--warning)';
          } else if (stats.is_running) {
            statusEl.innerHTML = '✅ Packet capture active - Duration: ' + (stats.capture_duration_seconds || 0).toFixed(0) + 's';
            statusEl.style.color = 'var(--accent)';
          } else {
            statusEl.innerHTML = '⚠️ Packet capture not running (requires sudo)';
            statusEl.style.color = 'var(--warning)';
          }
        }
        
        // Update packets chart with history
        networkPacketsHistory.push(stats.total_packets || 0);
        if (networkPacketsHistory.length > 60) networkPacketsHistory.shift();
        
        drawChart('packetsChart', [
          { label: 'Packets', data: networkPacketsHistory, color: '#a855f7' }
        ]);
        
      } catch (e) {
        console.error('Network stats error:', e);
      }
    }
    
    async function loadNetworkPackets() {
      const tbody = document.getElementById('networkPacketBody');
      if (!tbody) return;
      
      try {
        const res = await fetch('/api/network/packets?limit=50');
        const data = await res.json();
        
        if (data.packets && data.packets.length > 0) {
          tbody.innerHTML = data.packets.map(function(p) {
            const time = p.timestamp ? new Date(p.timestamp).toLocaleTimeString() : '--';
            const isSuspicious = p.is_suspicious;
            const isExternal = p.src_external || p.dst_external;
            
            // Determine row styling
            let rowStyle = '';
            let statusBadge = '<span style="color: var(--accent);">OK</span>';
            
            if (isSuspicious) {
              rowStyle = 'background: rgba(239, 68, 68, 0.1); border-left: 3px solid var(--error);';
              const reasons = (p.suspicious_reasons || []).slice(0, 2).join(', ');
              statusBadge = '<span style="color: var(--error); font-weight: 600;" title="' + reasons + '">🚨 SUSPICIOUS</span>';
            } else if (isExternal) {
              rowStyle = 'background: rgba(245, 166, 35, 0.1);';
              statusBadge = '<span style="color: var(--warning);">🌐 External</span>';
            }
            
            // Style IPs
            const srcStyle = p.src_external ? 'color: var(--warning); font-weight: 500;' : '';
            const dstStyle = p.dst_external ? 'color: var(--warning); font-weight: 500;' : '';
            
            // Truncate payload
            const payload = (p.payload_preview || '').substring(0, 30) || '-';
            
            return '<tr style="' + rowStyle + '">' +
              '<td style="font-family: JetBrains Mono, monospace; font-size: 12px;">' + time + '</td>' +
              '<td style="font-family: JetBrains Mono, monospace; ' + srcStyle + '">' + (p.src_ip || '-') + '</td>' +
              '<td style="font-family: JetBrains Mono, monospace; ' + dstStyle + '">' + (p.dst_ip || '-') + '</td>' +
              '<td>' + (p.port || '-') + '</td>' +
              '<td><span style="background: var(--bg-secondary); padding: 2px 8px; border-radius: 4px; font-size: 12px;">' + (p.protocol || '-') + '</span></td>' +
              '<td style="font-family: JetBrains Mono, monospace; font-size: 11px; max-width: 150px; overflow: hidden; text-overflow: ellipsis;">' + payload + '</td>' +
              '<td>' + statusBadge + '</td>' +
            '</tr>';
          }).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No packets captured. Run backend with sudo for packet sniffing.</td></tr>';
        }
      } catch (e) {
        console.error('Network packets error:', e);
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--error);">Error loading packets</td></tr>';
      }
    }
    
    // Auto-refresh Network view if active
    setInterval(() => {
      if (currentView === 'network') loadNetworkView();
    }, 2000);
    
    // ==========================================
    // ALERTS VIEW DATA LOADING
    // ==========================================
    async function loadAlerts() {
      const activeContainer = document.getElementById('alertsContainer');
      const historyBody = document.getElementById('alertHistoryBody');
      if (!activeContainer || !historyBody) return;
      
      try {
        const res = await fetch('/api/alerts');
        const data = await res.json();
        
        // Render Active Alerts
        if (data.active && data.active.length > 0) {
          activeContainer.innerHTML = data.active.map(function(alert) {
            const severityColor = alert.severity === 'CRITICAL' ? 'var(--error)' : alert.severity === 'WARNING' ? 'var(--warning)' : 'var(--accent)';
            const timestamp = new Date(alert.triggered_at).toLocaleString();
            const alertId = alert.id || Math.random().toString(36).substr(2, 9);
            
            return '<div class="alert-card" id="alert-' + alertId + '" style="background: var(--bg-secondary); border: 1px solid var(--border); border-left: 4px solid ' + severityColor + '; border-radius: 8px; padding: 16px;">' +
              '<div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">' +
                '<div>' +
                  '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">' +
                    '<span style="font-weight: 600; color: var(--text-primary); font-size: 16px;">' + alert.metric_name + '</span>' +
                    '<span style="background: ' + severityColor + '20; color: ' + severityColor + '; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">' + alert.severity + '</span>' +
                  '</div>' +
                  '<div style="font-size: 12px; color: var(--text-muted);">Triggered: ' + timestamp + '</div>' +
                '</div>' +
                '<div style="text-align: right; font-family: monospace;">' +
                  '<div style="font-size: 18px; color: ' + severityColor + ';">' + parseFloat(alert.current_value).toFixed(2) + '</div>' +
                  '<div style="font-size: 11px; color: var(--text-muted);">Threshold: ' + alert.threshold + '</div>' +
                '</div>' +
              '</div>' +
              '<div id="diagnosis-' + alertId + '" style="display: none; margin-top: 16px; padding: 12px; background: rgba(0,0,0,0.2); border-radius: 6px;">' +
                '<div style="font-size: 13px; font-weight: 600; margin-bottom: 8px; color: var(--accent);">🤖 AI Diagnosis</div>' +
                '<div class="diagnosis-content" style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;"></div>' +
                '<div class="remediation-box" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">' +
                  '<div style="font-size: 12px; font-weight: 600; margin-bottom: 4px;">Recommended Remediation:</div>' +
                  '<div class="remediation-text" style="font-size: 13px; color: var(--text-primary); margin-bottom: 12px; font-style: italic;"></div>' +
                  '<div style="display: flex; gap: 8px;">' +
                    '<button class="btn btn-sm" style="background: var(--success); border-color: var(--success); color: white;" onclick="approveRemediation(\\'' + alertId + '\\')">Approve Fix</button>' +
                    '<button class="btn btn-sm btn-outline" style="color: var(--error); border-color: var(--error);" onclick="rejectRemediation(\\'' + alertId + '\\')">Reject</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              '<div style="margin-top: 12px; display: flex; gap: 8px;" id="actions-' + alertId + '">' +
                '<button class="btn btn-sm btn-outline" onclick="diagnoseAlert(\\'' + alertId + '\\', \\'' + alert.metric_name + '\\', ' + alert.current_value + ', ' + alert.threshold + ', \\'' + alert.severity + '\\')">🔍 Diagnose with AI</button>' +
                '<button class="btn btn-sm btn-outline" onclick="acknowledgeAlert(\\'' + alertId + '\\')">✓ Acknowledge</button>' +
              '</div>' +
            '</div>';
          }).join('');
        } else {
          activeContainer.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted); background: var(--bg-secondary); border-radius: 8px;">No active alerts</div>';
        }
        
        // Render History
        if (data.history && data.history.length > 0) {
          historyBody.innerHTML = data.history.map(function(alert) {
            const timestamp = new Date(alert.resolved_at || alert.triggered_at).toLocaleString();
            const remediation = (alert.metadata && alert.metadata.remediation) || 'N/A';
            const status = alert.status || (alert.resolved ? 'Closed' : 'Open');
            const statusColors = { 'Closed': 'var(--success)', 'Open': 'var(--warning)', 'In-progress': 'var(--accent)' };
            const statusColor = statusColors[status] || 'var(--text-muted)';
            
            return '<tr>' +
              '<td style="color: var(--text-muted); font-size: 12px;">' + timestamp + '</td>' +
              '<td style="font-weight: 500;">' + alert.metric_name + '</td>' +
              '<td style="color: var(--text-secondary);">' + remediation + '</td>' +
              '<td><span style="color: ' + statusColor + '; font-weight: 600;">' + status + '</span></td>' +
            '</tr>';
          }).join('');
        } else {
          historyBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No alert history found</td></tr>';
        }
      } catch (e) {
        console.error('Failed to load alerts:', e);
        activeContainer.innerHTML = '<div style="color: var(--error); text-align: center;">Failed to load alerts</div>';
      }
    }
    
    // Interactive Alert Functions
    window.diagnoseAlert = async function(id, metric, value, threshold, severity) {
      const diagDiv = document.getElementById('diagnosis-' + id);
      const btnDiv = document.getElementById('actions-' + id);
      if (!diagDiv) return;
      
      diagDiv.style.display = 'block';
      diagDiv.querySelector('.diagnosis-content').innerHTML = '<span style="color: var(--accent);">Analyzing...</span>';
      
      try {
        const res = await fetch('/api/alerts/' + id + '/diagnose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert_id: id, metric_name: metric, current_value: value, threshold: threshold })
        });
        const data = await res.json();
        
        diagDiv.dataset.remediation = data.remediation || 'Check manual logs';
        diagDiv.dataset.severity = severity;
        diagDiv.dataset.metric = metric;
        
        diagDiv.querySelector('.diagnosis-content').textContent = data.analysis || 'No analysis provided';
        diagDiv.querySelector('.remediation-text').textContent = data.remediation || 'Investigate manually';
        
        if (btnDiv) btnDiv.style.display = 'none';
      } catch (e) {
        diagDiv.querySelector('.diagnosis-content').textContent = 'Diagnosis failed. Please check backend logs.';
      }
    };
    
    window.approveRemediation = async function(id) {
      const diagDiv = document.getElementById('diagnosis-' + id);
      if (!diagDiv) return;
      
      try {
        await fetch('/api/alerts/' + id + '/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert_id: id, remediation: diagDiv.dataset.remediation })
        });
        alert('Remediation approved!');
        setTimeout(loadAlerts, 1000);
      } catch (e) {
        console.error(e);
        alert('Failed to approve remediation');
      }
    };
    
    window.rejectRemediation = async function(id) {
      if (!confirm('Reject this remediation plan?')) return;
      
      try {
        await fetch('/api/alerts/' + id + '/reject', { method: 'POST' });
        document.getElementById('diagnosis-' + id).style.display = 'none';
        document.getElementById('actions-' + id).style.display = 'flex';
      } catch (e) { console.error(e); }
    };
    
    window.acknowledgeAlert = async function(id) {
      const card = document.getElementById('alert-' + id);
      if (card) card.style.opacity = '0.6';
    };
  </script>
</body>
</html>
`

export default {
  port: 3001,
  fetch: app.fetch,
}

console.log('🔷 AIOps Command Center BEAST MODE running at http://localhost:3001')
