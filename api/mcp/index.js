const { getMCPManager } = require('./client');

// ============================================
// MCP CONFIGURATION ENDPOINT
// Manages MCP server connections
// ============================================

// Default MCP server configurations
// Users can add more via the API
const DEFAULT_SERVERS = [
    // Example: Filesystem server (requires @modelcontextprotocol/server-filesystem)
    // {
    //     name: 'filesystem',
    //     command: 'npx',
    //     args: ['-y', '@modelcontextprotocol/server-filesystem', '/allowed/path'],
    //     env: {}
    // }
];

module.exports = async function (context, req) {
    const manager = getMCPManager();

    // GET - List connected servers and available tools
    if (req.method === 'GET') {
        const action = req.query.action;

        if (action === 'tools') {
            // Return all available tools
            context.res = {
                body: {
                    tools: manager.getTools(),
                    openaiFormat: manager.getToolsForOpenAI()
                }
            };
            return;
        }

        // Default: return status
        context.res = {
            body: {
                status: manager.getStatus(),
                toolCount: manager.getTools().length,
                tools: manager.getTools().map(t => ({
                    name: t.fullName,
                    description: t.description
                }))
            }
        };
        return;
    }

    // POST - Add/configure MCP servers
    if (req.method === 'POST') {
        const { action, server, toolName, toolArgs } = req.body || {};

        // Connect to a new MCP server
        if (action === 'connect') {
            if (!server || !server.name || !server.command) {
                context.res = {
                    status: 400,
                    body: { error: 'Server config required: { name, command, args?, env? }' }
                };
                return;
            }

            try {
                const result = await manager.addServer(server);
                context.res = {
                    body: result
                };
            } catch (error) {
                context.res = {
                    status: 500,
                    body: { error: error.message }
                };
            }
            return;
        }

        // Execute a tool
        if (action === 'execute') {
            if (!toolName) {
                context.res = {
                    status: 400,
                    body: { error: 'toolName required' }
                };
                return;
            }

            try {
                const result = await manager.executeTool(toolName, toolArgs || {});
                context.res = {
                    body: { success: true, result }
                };
            } catch (error) {
                context.res = {
                    status: 500,
                    body: { error: error.message }
                };
            }
            return;
        }

        // Disconnect all servers
        if (action === 'disconnect') {
            manager.disconnectAll();
            context.res = {
                body: { success: true, message: 'All servers disconnected' }
            };
            return;
        }

        // Initialize default servers
        if (action === 'init') {
            const results = [];
            for (const serverConfig of DEFAULT_SERVERS) {
                const result = await manager.addServer(serverConfig);
                results.push({ server: serverConfig.name, ...result });
            }
            context.res = {
                body: { initialized: results }
            };
            return;
        }

        context.res = {
            status: 400,
            body: { error: 'Unknown action. Use: connect, execute, disconnect, init' }
        };
        return;
    }

    context.res = {
        status: 405,
        body: { error: 'Method not allowed' }
    };
};
