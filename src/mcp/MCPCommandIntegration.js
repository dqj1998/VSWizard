const vscode = require('vscode');

/**
 * Helper function to handle MCP server actions
 */
async function handleMcpServerAction(mcpServerManager, server, action) {
    try {
        switch (action) {
            case 'Start':
                await mcpServerManager.startServer(server.id);
                break;
            case 'Stop':
                await mcpServerManager.stopServer(server.id);
                break;
            case 'Restart':
                await mcpServerManager.restartServer(server.id);
                break;
            case 'Uninstall':
                const confirm = await vscode.window.showWarningMessage(
                    `Are you sure you want to uninstall ${server.name}?`,
                    { modal: true },
                    'Yes', 'No'
                );
                if (confirm === 'Yes') {
                    await mcpServerManager.uninstallServer(server.id);
                }
                break;
            case 'View Details':
                const status = mcpServerManager.getServerStatus(server.id);
                const health = await mcpServerManager.getServerHealth(server.id);
                const details = [
                    `Name: ${server.name}`,
                    `ID: ${server.id}`,
                    `Version: ${server.version}`,
                    `Description: ${server.description || 'No description'}`,
                    `Status: ${status.status}`,
                    `Connected: ${status.connected ? 'Yes' : 'No'}`,
                    `Install Method: ${server.installMethod}`,
                    `Command: ${server.command} ${server.args.join(' ')}`,
                    `Health: ${health.healthy ? 'Healthy' : 'Unhealthy'}`,
                    health.message ? `Message: ${health.message}` : ''
                ].filter(Boolean).join('\n');
                
                vscode.window.showInformationMessage(details, { modal: true });
                break;
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Action failed: ${error.message}`);
    }
}

/**
 * Register MCP commands with the extension context
 */
function registerMcpCommands(context, mcpServerManager) {
    // Command: Install MCP Server
    const mcpInstallCommand = vscode.commands.registerCommand('vswizard.mcpInstall', async function (url) {
        try {
            // If no URL provided, prompt user
            if (!url) {
                url = await vscode.window.showInputBox({
                    prompt: 'Enter MCP server URL or package name',
                    placeHolder: 'e.g., npm:@modelcontextprotocol/server-filesystem, https://github.com/user/mcp-server.git',
                    ignoreFocusOut: true
                });
                
                if (!url) {
                    return; // User cancelled
                }
            }
            
            // Show progress
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Installing MCP Server',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `Installing from ${url}...` });
                
                const serverConfig = await mcpServerManager.installServer(url, {
                    onProgress: (progressData) => {
                        if (progressData.type === 'stdout') {
                            progress.report({ message: progressData.data.trim() });
                        }
                    },
                    autoStart: true
                });
                
                progress.report({ message: `Installation completed: ${serverConfig.name}` });
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`MCP Server installation failed: ${error.message}`);
        }
    });
    context.subscriptions.push(mcpInstallCommand);
    
    // Command: List MCP Servers
    const mcpListCommand = vscode.commands.registerCommand('vswizard.mcpList', async function () {
        try {
            const servers = mcpServerManager.listServers();
            
            if (servers.length === 0) {
                vscode.window.showInformationMessage('No MCP servers installed.');
                return;
            }
            
            // Create a map to store label to server object mapping
            const serverMap = new Map();
            
            // Create serverItems with labels only (since showQuickPick returns strings)
            const serverItems = servers.map(server => {
                const status = mcpServerManager.getServerStatus(server.id);
                const statusIcon = status.connected ? '🟢' : '🔴';
                const label = `${statusIcon} ${server.name}`;
                
                // Store the mapping
                serverMap.set(label, server);
                
                return {
                    label: label,
                    description: server.description || 'No description',
                    detail: `ID: ${server.id} | Version: ${server.version} | Status: ${status.status}`
                };
            });
            
            const selected = await vscode.window.showQuickPick(serverItems, {
                placeHolder: 'Select an MCP server to manage'
            });
            
            if (selected) {
                // selected is a string (the label), find the server using the label
                const server = serverMap.get(selected);
                if (!server) {
                    vscode.window.showErrorMessage(`Server not found for selection: ${selected}`);
                    return;
                }
                
                // Show server management options
                const actions = ['Start', 'Stop', 'Restart', 'Uninstall', 'View Details'];
                const action = await vscode.window.showQuickPick(actions, {
                    placeHolder: `What would you like to do with ${server.name}?`
                });
                
                if (action) {
                    await handleMcpServerAction(mcpServerManager, server, action);
                }
            }
            
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to list MCP servers: ${error.message}`);
        }
    });
    context.subscriptions.push(mcpListCommand);
    
    // Command: Start MCP Server
    const mcpStartCommand = vscode.commands.registerCommand('vswizard.mcpStart', async function (serverId) {
        try {
            if (!serverId) {
                const servers = mcpServerManager.listServers();
                const stoppedServers = servers.filter(s => {
                    const status = mcpServerManager.getServerStatus(s.id);
                    return !status.connected;
                });
                
                if (stoppedServers.length === 0) {
                    vscode.window.showInformationMessage('No stopped MCP servers found.');
                    return;
                }
                
                // Create a map for server lookup
                const serverMap = new Map();
                const serverItems = stoppedServers.map(s => {
                    const label = s.name;
                    serverMap.set(label, s);
                    return {
                        label: label,
                        description: s.description
                    };
                });
                
                const selected = await vscode.window.showQuickPick(serverItems, {
                    placeHolder: 'Select MCP server to start'
                });
                
                if (!selected) return;
                
                // selected is a string (the label)
                const server = serverMap.get(selected);
                if (!server) {
                    vscode.window.showErrorMessage(`Server not found: ${selected}`);
                    return;
                }
                serverId = server.id;
            }
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Starting MCP Server',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `Starting ${serverId}...` });
                await mcpServerManager.startServer(serverId);
            });
            
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to start MCP server: ${error.message}`);
        }
    });
    context.subscriptions.push(mcpStartCommand);
    
    // Command: Stop MCP Server
    const mcpStopCommand = vscode.commands.registerCommand('vswizard.mcpStop', async function (serverId) {
        try {
            if (!serverId) {
                const activeConnections = mcpServerManager.getActiveConnections();
                
                if (activeConnections.size === 0) {
                    vscode.window.showInformationMessage('No running MCP servers found.');
                    return;
                }
                
                // Create a map for server lookup
                const serverMap = new Map();
                const serverItems = Array.from(activeConnections.keys()).map(id => {
                    const server = mcpServerManager.registry.getServer(id);
                    const label = server.name;
                    serverMap.set(label, server);
                    return {
                        label: label,
                        description: server.description
                    };
                });
                
                const selected = await vscode.window.showQuickPick(serverItems, {
                    placeHolder: 'Select MCP server to stop'
                });
                
                if (!selected) return;
                
                // selected is a string (the label)
                const server = serverMap.get(selected);
                if (!server) {
                    vscode.window.showErrorMessage(`Server not found: ${selected}`);
                    return;
                }
                serverId = server.id;
            }
            
            await mcpServerManager.stopServer(serverId);
            
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to stop MCP server: ${error.message}`);
        }
    });
    context.subscriptions.push(mcpStopCommand);
    
    // Command: Uninstall MCP Server
    const mcpUninstallCommand = vscode.commands.registerCommand('vswizard.mcpUninstall', async function (serverId) {
        try {
            if (!serverId) {
                const servers = mcpServerManager.listServers();
                if (servers.length === 0) {
                    vscode.window.showInformationMessage('No MCP servers installed.');
                    return;
                }
                // Create a map for server lookup
                const serverMap = new Map();
                const serverItems = servers.map(s => {
                    const status = mcpServerManager.getServerStatus(s.id);
                    const statusIcon = status.connected ? '🟢' : '🔴';
                    const label = `${statusIcon} ${s.name}`;
                    serverMap.set(label, s);
                    return {
                        label: label,
                        description: s.description || 'No description',
                        detail: `ID: ${s.id} | Version: ${s.version} | Method: ${s.installMethod}`
                    };
                });
                const selected = await vscode.window.showQuickPick(serverItems, {
                    placeHolder: 'Select MCP server to uninstall'
                });
                if (!selected) return;
                // selected can be a string (label) or an object with a label property
                const key = typeof selected === 'string' ? selected : selected.label;
                const server = serverMap.get(key);
                if (!server) {
                    vscode.window.showErrorMessage(`Server not found: ${key}`);
                    return;
                }
                serverId = server.id;
            }
            
            const serverConfig = mcpServerManager.registry.getServer(serverId);
            if (!serverConfig) {
                vscode.window.showErrorMessage(`Server not found: ${serverId}`);
                return;
            }
            
            // Confirm uninstallation
            const confirm = await vscode.window.showWarningMessage(
                `Are you sure you want to uninstall ${serverConfig.name}?`,
                { modal: true },
                'Yes', 'No'
            );
            
            if (confirm !== 'Yes') {
                return;
            }
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Uninstalling MCP Server',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: `Uninstalling ${serverConfig.name}...` });
                await mcpServerManager.uninstallServer(serverId);
                progress.report({ message: `Uninstallation completed: ${serverConfig.name}` });
            });
            
            vscode.window.showInformationMessage(`Successfully uninstalled ${serverConfig.name}`);
            
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to uninstall MCP server: ${error.message}`);
        }
    });
    context.subscriptions.push(mcpUninstallCommand);
}

module.exports = {
    registerMcpCommands,
    handleMcpServerAction
};