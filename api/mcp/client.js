// ============================================
// MCP CLIENT - Model Context Protocol Client
// Allows agents to consume external MCP servers
// ============================================

const { spawn } = require('child_process');

/**
 * MCP Client for connecting to MCP servers via stdio transport
 * Implements the Model Context Protocol specification
 */
class MCPClient {
    constructor(config) {
        this.serverName = config.name;
        this.command = config.command;
        this.args = config.args || [];
        this.env = config.env || {};
        this.process = null;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.tools = [];
        this.resources = [];
        this.connected = false;
        this.buffer = '';
    }

    /**
     * Connect to the MCP server
     */
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.process = spawn(this.command, this.args, {
                    env: { ...process.env, ...this.env },
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                this.process.stdout.on('data', (data) => {
                    this.handleData(data.toString());
                });

                this.process.stderr.on('data', (data) => {
                    console.error(`[MCP ${this.serverName}] stderr:`, data.toString());
                });

                this.process.on('error', (err) => {
                    console.error(`[MCP ${this.serverName}] process error:`, err);
                    this.connected = false;
                    reject(err);
                });

                this.process.on('close', (code) => {
                    console.log(`[MCP ${this.serverName}] process exited with code ${code}`);
                    this.connected = false;
                });

                // Initialize the connection
                this.initialize()
                    .then(() => {
                        this.connected = true;
                        resolve();
                    })
                    .catch(reject);

            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Handle incoming data from the MCP server
     */
    handleData(data) {
        this.buffer += data;

        // Process complete JSON-RPC messages (newline delimited)
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const message = JSON.parse(line);
                this.handleMessage(message);
            } catch (err) {
                console.error(`[MCP ${this.serverName}] Failed to parse message:`, line);
            }
        }
    }

    /**
     * Handle a parsed JSON-RPC message
     */
    handleMessage(message) {
        // Check if this is a response to a pending request
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);

            if (message.error) {
                reject(new Error(message.error.message || 'MCP error'));
            } else {
                resolve(message.result);
            }
        }
        // Handle notifications from server
        else if (message.method) {
            this.handleNotification(message);
        }
    }

    /**
     * Handle server notifications
     */
    handleNotification(notification) {
        console.log(`[MCP ${this.serverName}] Notification:`, notification.method);
    }

    /**
     * Send a JSON-RPC request to the MCP server
     */
    async sendRequest(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const request = {
                jsonrpc: '2.0',
                id,
                method,
                params
            };

            this.pendingRequests.set(id, { resolve, reject });

            const message = JSON.stringify(request) + '\n';
            this.process.stdin.write(message);

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${method}`));
                }
            }, 30000);
        });
    }

    /**
     * Initialize the MCP connection
     */
    async initialize() {
        const result = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {
                roots: { listChanged: true }
            },
            clientInfo: {
                name: 'AI Agent Hub',
                version: '1.0.0'
            }
        });

        // Send initialized notification
        const notification = JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        }) + '\n';
        this.process.stdin.write(notification);

        return result;
    }

    /**
     * List available tools from the MCP server
     */
    async listTools() {
        const result = await this.sendRequest('tools/list');
        this.tools = result.tools || [];
        return this.tools;
    }

    /**
     * List available resources from the MCP server
     */
    async listResources() {
        const result = await this.sendRequest('resources/list');
        this.resources = result.resources || [];
        return this.resources;
    }

    /**
     * Call a tool on the MCP server
     */
    async callTool(name, args = {}) {
        const result = await this.sendRequest('tools/call', {
            name,
            arguments: args
        });
        return result;
    }

    /**
     * Read a resource from the MCP server
     */
    async readResource(uri) {
        const result = await this.sendRequest('resources/read', { uri });
        return result;
    }

    /**
     * Disconnect from the MCP server
     */
    disconnect() {
        if (this.process) {
            this.process.kill();
            this.process = null;
            this.connected = false;
        }
    }
}

/**
 * MCP Manager - Manages multiple MCP server connections
 */
class MCPManager {
    constructor() {
        this.clients = new Map();
        this.allTools = [];
    }

    /**
     * Add and connect to an MCP server
     */
    async addServer(config) {
        const client = new MCPClient(config);

        try {
            await client.connect();
            const tools = await client.listTools();

            // Store client and tools
            this.clients.set(config.name, client);

            // Add tools with server prefix
            for (const tool of tools) {
                this.allTools.push({
                    ...tool,
                    serverName: config.name,
                    fullName: `${config.name}__${tool.name}`
                });
            }

            console.log(`[MCP] Connected to ${config.name} with ${tools.length} tools`);
            return { success: true, tools };

        } catch (err) {
            console.error(`[MCP] Failed to connect to ${config.name}:`, err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Get all available tools from all connected servers
     */
    getTools() {
        return this.allTools;
    }

    /**
     * Get tools formatted for OpenAI function calling
     */
    getToolsForOpenAI() {
        return this.allTools.map(tool => ({
            type: 'function',
            function: {
                name: tool.fullName,
                description: tool.description || `Tool from ${tool.serverName}`,
                parameters: tool.inputSchema || { type: 'object', properties: {} }
            }
        }));
    }

    /**
     * Execute a tool by its full name
     */
    async executeTool(fullName, args) {
        const tool = this.allTools.find(t => t.fullName === fullName);
        if (!tool) {
            throw new Error(`Unknown tool: ${fullName}`);
        }

        const client = this.clients.get(tool.serverName);
        if (!client || !client.connected) {
            throw new Error(`Server not connected: ${tool.serverName}`);
        }

        const result = await client.callTool(tool.name, args);
        return result;
    }

    /**
     * Get connection status for all servers
     */
    getStatus() {
        const status = {};
        for (const [name, client] of this.clients) {
            status[name] = {
                connected: client.connected,
                toolCount: client.tools.length
            };
        }
        return status;
    }

    /**
     * Disconnect all servers
     */
    disconnectAll() {
        for (const client of this.clients.values()) {
            client.disconnect();
        }
        this.clients.clear();
        this.allTools = [];
    }
}

// Singleton instance
let mcpManager = null;

function getMCPManager() {
    if (!mcpManager) {
        mcpManager = new MCPManager();
    }
    return mcpManager;
}

module.exports = {
    MCPClient,
    MCPManager,
    getMCPManager
};
