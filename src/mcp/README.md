# MCPClient - Model Context Protocol Integration

This directory contains the core MCPClient implementation for integrating MCP (Model Context Protocol) servers with the VSWizard VSCode extension.

## Overview

The MCPClient provides a robust, event-driven interface for communicating with MCP servers via STDIO. It implements the full MCP protocol specification including:

- **STDIO Communication**: Spawns and manages MCP server processes
- **JSON-RPC Protocol**: Handles request/response and notification messages
- **Connection Management**: Automatic reconnection and error recovery
- **Tool Discovery & Invocation**: List and call available tools
- **Resource Access**: Read and list server resources
- **Prompt Templates**: Access server-provided prompt templates
- **Event System**: Real-time status updates and notifications

## Files

- **`MCPClient.js`** - Core MCPClient class implementation
- **`MCPClient.test.js`** - Comprehensive test suite with mock server
- **`README.md`** - This documentation file

## Quick Start

```javascript
const MCPClient = require('./MCPClient');

// Create client instance
const client = new MCPClient({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/directory'],
    name: 'Filesystem MCP Server',
    timeout: 30000
});

// Set up event listeners
client.on('connected', (serverInfo) => {
    console.log('Connected to:', serverInfo.serverInfo.name);
});

client.on('error', (error) => {
    console.error('MCP Error:', error.message);
});

// Connect and use
await client.connect();
const tools = await client.listTools();
const result = await client.callTool('read_file', { path: '/example.txt' });
await client.disconnect();
```

## Integration with VSWizard

The MCPClient is designed to integrate seamlessly with the existing VSWizard extension architecture:

### 1. Extension Integration

```javascript
// In extension.js
const MCPClient = require('./src/mcp/MCPClient');

function activate(context) {
    // Initialize MCP clients for configured servers
    const mcpClients = new Map();
    
    // Example: Add filesystem MCP server
    const fsClient = new MCPClient({
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', context.extensionPath],
        name: 'Filesystem Server'
    });
    
    mcpClients.set('filesystem', fsClient);
    
    // Connect to servers
    fsClient.connect().then(() => {
        console.log('Filesystem MCP server connected');
    }).catch(console.error);
    
    // Store in context for cleanup
    context.subscriptions.push({
        dispose: async () => {
            for (const client of mcpClients.values()) {
                await client.disconnect();
            }
        }
    });
}
```

### 2. Chat Integration

The MCPClient can enhance the existing chat functionality by providing access to tools and resources:

```javascript
// In ChatViewProvider
async handleMCPToolCall(toolName, arguments) {
    const client = this.mcpClients.get('filesystem');
    if (client && client.isConnected()) {
        try {
            const result = await client.callTool(toolName, arguments);
            return result;
        } catch (error) {
            console.error('MCP tool call failed:', error);
            throw error;
        }
    }
    throw new Error('MCP client not available');
}
```

### 3. Command Integration

Add new VSCode commands for MCP functionality:

```javascript
// Register MCP-related commands
const listMCPToolsCommand = vscode.commands.registerCommand('vswizard.listMCPTools', async () => {
    const client = mcpClients.get('filesystem');
    if (client && client.isConnected()) {
        const tools = await client.listTools();
        // Show tools in QuickPick
        const toolNames = tools.map(tool => tool.name);
        const selected = await vscode.window.showQuickPick(toolNames);
        if (selected) {
            // Handle tool selection
        }
    }
});
```

## Configuration

MCP servers can be configured through VSCode settings:

```json
{
    "vswizard.mcpServers": [
        {
            "name": "filesystem",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"],
            "description": "File system access"
        },
        {
            "name": "git",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-git", "${workspaceFolder}"],
            "description": "Git operations"
        }
    ]
}
```

## Event System

The MCPClient emits various events for monitoring and integration:

- **`connecting`** - Connection attempt started
- **`connected`** - Successfully connected to server
- **`disconnected`** - Connection closed
- **`reconnecting`** - Attempting to reconnect
- **`error`** - Error occurred
- **`toolCalled`** - Tool was invoked
- **`resourceRead`** - Resource was accessed
- **`promptRetrieved`** - Prompt template was retrieved
- **`toolsChanged`** - Server tools list changed
- **`resourcesChanged`** - Server resources list changed
- **`promptsChanged`** - Server prompts list changed

## Error Handling

The MCPClient includes comprehensive error handling:

- **Connection Errors**: Automatic reconnection with exponential backoff
- **Protocol Errors**: Proper JSON-RPC error responses
- **Timeout Handling**: Configurable request timeouts
- **Process Management**: Clean process cleanup and resource management

## Testing

Run the test suite to verify functionality:

```bash
cd src/mcp
node MCPClient.test.js
```

The test suite includes:
- Connection lifecycle testing
- Tool operations testing
- Resource access testing
- Prompt template testing
- Error handling validation
- Event emission verification

## Popular MCP Servers

Here are some popular MCP servers you can integrate:

- **@modelcontextprotocol/server-filesystem** - File system operations
- **@modelcontextprotocol/server-git** - Git repository operations
- **@modelcontextprotocol/server-sqlite** - SQLite database access
- **@modelcontextprotocol/server-postgres** - PostgreSQL database access
- **@modelcontextprotocol/server-brave-search** - Web search capabilities
- **@modelcontextprotocol/server-github** - GitHub API integration

## Architecture Decisions

### 1. Event-Driven Design
The MCPClient uses EventEmitter to provide real-time status updates, making it easy to integrate with UI components and provide user feedback.

### 2. Automatic Reconnection
Built-in reconnection logic with exponential backoff ensures robust operation even when MCP servers are unstable.

### 3. Caching Strategy
Tools, resources, and prompts are cached locally to reduce server round-trips and improve performance.

### 4. Promise-Based API
All async operations return Promises, making it easy to integrate with modern JavaScript patterns.

### 5. Comprehensive Error Handling
Detailed error messages and proper error propagation help with debugging and user experience.

## Future Enhancements

Potential future improvements:

1. **Connection Pooling** - Support multiple concurrent connections
2. **Batch Operations** - Batch multiple requests for efficiency
3. **Streaming Support** - Handle streaming responses for large data
4. **Security Features** - Add authentication and authorization
5. **Performance Monitoring** - Add metrics and performance tracking
6. **Configuration UI** - Visual configuration interface for MCP servers

## Contributing

When extending the MCPClient:

1. Follow the existing error handling patterns
2. Add appropriate event emissions for new functionality
3. Update tests for new features
4. Maintain backward compatibility
5. Document new methods and events