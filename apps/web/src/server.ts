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
app.get('/api/alerts', async (c) => {
  try {
    const response = await fetch('http://localhost:19999/api/v1/alarms?active')
    const data = await response.json()
    return c.json(data)
  } catch (error) {
    return c.json({ error: 'Failed to fetch alerts' }, 500)
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
      --chart-5: #ff4d4f;
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
    
    /* Dashboard Grid */
    .dashboard {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
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
      width: 420px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      max-height: 500px;
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
      font-size: 14px;
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
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.5;
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
      padding: 12px 50px 12px 16px;
      color: var(--text-primary);
      font-size: 14px;
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
        <div class="nav-item" onclick="showTab('processes')">
          <span class="nav-icon">⚙️</span>
          <span>Processes</span>
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
        <div class="tab active" data-tab="overview">Overview</div>
        <div class="tab" data-tab="cpu">CPU</div>
        <div class="tab" data-tab="memory">Memory</div>
        <div class="tab" data-tab="network">Network</div>
        <div class="tab" data-tab="disk">Disk I/O</div>
      </div>

      <!-- Dashboard -->
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
    </div>
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
      
      // Clear
      ctx.fillStyle = '#171717';
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
      ctx.strokeStyle = '#2d2d2d';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartHeight / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(width - padding.right, y);
        ctx.stroke();
        
        // Y axis labels
        ctx.fillStyle = '#6b6b6b';
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
        
        const step = chartWidth / (maxPoints - 1);
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
          ctx.fillStyle = '#ababab';
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
      } catch (e) {}
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
      } catch (e) {}
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
      } catch (e) {}
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
      } catch (e) {}
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
      } catch (e) {}
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
        } else {
          list.innerHTML = alerts.map(a => \`
            <div class="alert-row">
              <div class="alert-severity \${a.status === 'CRITICAL' ? 'critical' : 'warning'}"></div>
              <div class="alert-content">
                <div class="alert-name">\${a.name}</div>
                <div class="alert-meta">\${a.chart} • \${a.status}</div>
              </div>
              <button class="btn btn-sm" onclick="diagnoseAlert('\${a.name}')">Diagnose</button>
            </div>
          \`).join('');
        }
      } catch (e) {
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
      } catch (e) {
        document.getElementById('netdataStatus').textContent = 'Disconnected';
      }
    }

    async function fetchCharts() {
      try {
        const res = await fetch('/api/charts');
        const data = await res.json();
        const count = Object.keys(data.charts || {}).length;
        document.getElementById('chartsCount').textContent = count;
      } catch (e) {}
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
      } catch (e) {}
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
        } else {
          slashMenu.classList.remove('visible');
        }
      } else {
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
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedIdx = Math.max(selectedIdx - 1, 0);
          chatInput.dispatchEvent(new Event('input'));
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          if (filtered.length > 0) {
            e.preventDefault();
            selectSlash(filtered[selectedIdx]);
          }
        } else if (e.key === 'Escape') {
          slashMenu.classList.remove('visible');
        }
      } else if (e.key === 'Enter' && !e.shiftKey) {
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
      } catch (e) {
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
        } else {
          container.innerHTML = actions.map(a => \`
            <div style="padding: 16px; border-bottom: 1px solid var(--border);">
              <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px;">
                <div>
                  <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
                    \${a.action_type.replace('_', ' ').toUpperCase()}
                  </div>
                  <div style="font-size: 12px; color: var(--text-muted);">
                    Target: \${a.target} | Severity: <span style="color: \${a.severity === 'CRITICAL' ? 'var(--error)' : a.severity === 'HIGH' ? 'var(--warning)' : 'var(--accent)'};">\${a.severity}</span>
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
      } catch (e) {
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
      } catch (e) {
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
      } catch (e) {
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
          } else if (data.type === 'action_resolved') {
            refreshPendingActions();
          }
        };
        ws.onclose = () => setTimeout(connectWebSocket, 3001);
      } catch (e) {
        console.log('WebSocket not available');
      }
    }
    connectWebSocket();
    
    // Initial fetch
    refreshPendingActions();
    setInterval(refreshPendingActions, 5000);

    function showTab(tab) {
      // Update nav
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      event.target.closest('.nav-item').classList.add('active');
      
      // Update tab bar
      document.querySelectorAll('.tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
      });
    }

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
  </script>
</body>
</html>
`

export default {
  port: 3001,
  fetch: app.fetch,
}

console.log('🔷 AIOps Command Center BEAST MODE running at http://localhost:3001')
