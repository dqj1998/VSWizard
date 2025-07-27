const MCPClient = require('./MCPClient');

/**
 * Simple test suite for MCPClient
 * This demonstrates basic usage and validates the implementation
 */

// Mock MCP server configuration for testing
const testServerConfig = {
    command: 'node',
    args: ['-e', `
        // Mock MCP server that responds to basic protocol messages
        const readline = require('readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false
        });
        
        rl.on('line', (line) => {
            try {
                const message = JSON.parse(line);
                let response;
                
                if (message.method === 'initialize') {
                    response = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: '2024-11-05',
                            capabilities: {
                                tools: { listChanged: true },
                                resources: { subscribe: true, listChanged: true },
                                prompts: { listChanged: true }
                            },
                            serverInfo: {
                                name: 'Test MCP Server',
                                version: '1.0.0'
                            }
                        }
                    };
                } else if (message.method === 'tools/list') {
                    response = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            tools: [
                                {
                                    name: 'test_tool',
                                    description: 'A test tool',
                                    inputSchema: {
                                        type: 'object',
                                        properties: {
                                            message: { type: 'string' }
                                        }
                                    }
                                }
                            ]
                        }
                    };
                } else if (message.method === 'tools/call') {
                    response = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            content: [
                                {
                                    type: 'text',
                                    text: \`Tool called with: \${JSON.stringify(message.params.arguments)}\`
                                }
                            ]
                        }
                    };
                } else if (message.method === 'resources/list') {
                    response = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            resources: [
                                {
                                    uri: 'test://resource1',
                                    name: 'Test Resource',
                                    description: 'A test resource',
                                    mimeType: 'text/plain'
                                }
                            ]
                        }
                    };
                } else if (message.method === 'resources/read') {
                    response = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            contents: [
                                {
                                    uri: message.params.uri,
                                    mimeType: 'text/plain',
                                    text: 'This is test resource content'
                                }
                            ]
                        }
                    };
                } else if (message.method === 'prompts/list') {
                    response = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            prompts: [
                                {
                                    name: 'test_prompt',
                                    description: 'A test prompt',
                                    arguments: [
                                        {
                                            name: 'topic',
                                            description: 'The topic to discuss',
                                            required: true
                                        }
                                    ]
                                }
                            ]
                        }
                    };
                } else if (message.method === 'prompts/get') {
                    response = {
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            description: 'Test prompt response',
                            messages: [
                                {
                                    role: 'user',
                                    content: {
                                        type: 'text',
                                        text: \`Please discuss: \${message.params.arguments.topic || 'general topic'}\`
                                    }
                                }
                            ]
                        }
                    };
                }
                
                if (response) {
                    console.log(JSON.stringify(response));
                }
            } catch (error) {
                // Ignore parsing errors
            }
        });
    `],
    name: 'Test MCP Server',
    timeout: 5000
};

/**
 * Run basic tests for MCPClient
 */
async function runTests() {
    console.log('🧪 Starting MCPClient tests...\n');
    
    const client = new MCPClient(testServerConfig);
    let testsPassed = 0;
    let testsTotal = 0;
    
    // Helper function for assertions
    function assert(condition, message) {
        testsTotal++;
        if (condition) {
            console.log(`✅ ${message}`);
            testsPassed++;
        } else {
            console.log(`❌ ${message}`);
        }
    }
    
    // Set up event listeners for testing
    const events = [];
    client.on('connecting', () => events.push('connecting'));
    client.on('connected', () => events.push('connected'));
    client.on('disconnected', () => events.push('disconnected'));
    client.on('error', (error) => events.push(`error: ${error.message}`));
    
    try {
        // Test 1: Initial state
        assert(!client.isConnected(), 'Client should not be connected initially');
        assert(client.getServerInfo() === null, 'Server info should be null initially');
        
        // Test 2: Connection
        console.log('\n🔌 Testing connection...');
        const serverInfo = await client.connect();
        assert(client.isConnected(), 'Client should be connected after connect()');
        assert(serverInfo !== null, 'Server info should be available after connection');
        assert(serverInfo.serverInfo.name === 'Test MCP Server', 'Server name should match');
        assert(events.includes('connecting'), 'Should emit connecting event');
        assert(events.includes('connected'), 'Should emit connected event');
        
        // Test 3: Tool operations
        console.log('\n🔧 Testing tool operations...');
        const tools = await client.listTools();
        assert(Array.isArray(tools), 'listTools should return an array');
        assert(tools.length > 0, 'Should have at least one tool');
        assert(tools[0].name === 'test_tool', 'First tool should be test_tool');
        
        const toolResult = await client.callTool('test_tool', { message: 'Hello' });
        assert(toolResult !== null, 'Tool call should return a result');
        assert(toolResult.content && toolResult.content.length > 0, 'Tool result should have content');
        
        // Test 4: Resource operations
        console.log('\n📁 Testing resource operations...');
        const resources = await client.listResources();
        assert(Array.isArray(resources), 'listResources should return an array');
        assert(resources.length > 0, 'Should have at least one resource');
        assert(resources[0].uri === 'test://resource1', 'First resource should have correct URI');
        
        const resourceContent = await client.readResource('test://resource1');
        assert(resourceContent !== null, 'Resource read should return content');
        assert(resourceContent.contents && resourceContent.contents.length > 0, 'Resource should have contents');
        
        // Test 5: Prompt operations
        console.log('\n💬 Testing prompt operations...');
        const prompts = await client.listPrompts();
        assert(Array.isArray(prompts), 'listPrompts should return an array');
        assert(prompts.length > 0, 'Should have at least one prompt');
        assert(prompts[0].name === 'test_prompt', 'First prompt should be test_prompt');
        
        const promptContent = await client.getPrompt('test_prompt', { topic: 'testing' });
        assert(promptContent !== null, 'Prompt get should return content');
        assert(promptContent.messages && promptContent.messages.length > 0, 'Prompt should have messages');
        
        // Test 6: Cached data
        console.log('\n💾 Testing cached data...');
        const cachedTools = client.getCachedTools();
        const cachedResources = client.getCachedResources();
        const cachedPrompts = client.getCachedPrompts();
        
        assert(cachedTools.size > 0, 'Should have cached tools');
        assert(cachedResources.size > 0, 'Should have cached resources');
        assert(cachedPrompts.size > 0, 'Should have cached prompts');
        assert(cachedTools.has('test_tool'), 'Should have test_tool in cache');
        
        // Test 7: Disconnection
        console.log('\n🔌 Testing disconnection...');
        await client.disconnect();
        assert(!client.isConnected(), 'Client should not be connected after disconnect()');
        assert(events.includes('disconnected'), 'Should emit disconnected event');
        
        // Test 8: Error handling
        console.log('\n⚠️  Testing error handling...');
        try {
            await client.listTools(); // Should fail when disconnected
            assert(false, 'Should throw error when calling methods while disconnected');
        } catch (error) {
            assert(error.message.includes('Not connected'), 'Should throw appropriate error message');
        }
        
    } catch (error) {
        console.log(`❌ Test failed with error: ${error.message}`);
        console.error(error);
    } finally {
        // Ensure cleanup
        if (client.isConnected()) {
            await client.disconnect();
        }
    }
    
    // Test summary
    console.log(`\n📊 Test Results: ${testsPassed}/${testsTotal} tests passed`);
    
    if (testsPassed === testsTotal) {
        console.log('🎉 All tests passed! MCPClient implementation is working correctly.');
        return true;
    } else {
        console.log('❌ Some tests failed. Please check the implementation.');
        return false;
    }
}

/**
 * Example usage demonstration
 */
async function demonstrateUsage() {
    console.log('\n📖 MCPClient Usage Example:\n');
    
    console.log(`
// 1. Create an MCPClient instance
const client = new MCPClient({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/directory'],
    name: 'Filesystem MCP Server'
});

// 2. Set up event listeners
client.on('connected', (serverInfo) => {
    console.log('Connected to:', serverInfo.serverInfo.name);
});

client.on('error', (error) => {
    console.error('MCP Error:', error.message);
});

// 3. Connect to the server
await client.connect();

// 4. Use the server capabilities
const tools = await client.listTools();
const resources = await client.listResources();
const prompts = await client.listPrompts();

// 5. Call a tool
const result = await client.callTool('read_file', {
    path: '/path/to/file.txt'
});

// 6. Read a resource
const content = await client.readResource('file:///path/to/resource');

// 7. Get a prompt
const prompt = await client.getPrompt('code_review', {
    language: 'javascript',
    file_path: '/path/to/code.js'
});

// 8. Clean up
await client.disconnect();
    `);
}

// Run tests if this file is executed directly
if (require.main === module) {
    runTests()
        .then((success) => {
            if (success) {
                demonstrateUsage();
            }
            process.exit(success ? 0 : 1);
        })
        .catch((error) => {
            console.error('Test execution failed:', error);
            process.exit(1);
        });
}

module.exports = { runTests, demonstrateUsage };