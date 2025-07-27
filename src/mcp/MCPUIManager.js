const vscode = require('vscode');
const { EventEmitter } = require('events');
const MCPServerManager = require('./MCPServerManager');

/**
 * MCPUIManager - Main UI coordination class for MCP server management
 * Handles all UI components and their interactions with the MCP system
 */
class MCPUIManager extends EventEmitter {
    /**
     * Initialize the UI manager
     * @param {Object} context - VSCode extension context
     * @param {MCPServerManager} mcpServerManager - MCP server manager instance
     */
    constructor(context, mcpServerManager) {
        super();
        
        this.context = context;
        this.mcpServerManager = mcpServerManager;
        
        // UI Components
        this.statusBarItem = null;
        this.outputChannel = null;
        this.mcpDropdownProvider = null;
        
        // State management
        this.activeServers = new Map(); // serverId -> server info
        this.selectedServers = new Set(); // Set of selected server IDs
        this.uiState = {
            statusBarVisible: true,
            dropdownVisible: true,
            outputChannelVisible: true
        };
        
        // Configuration
        this.config = {
            connectionTimeout: 30000,
            retryCount: 3,
            autoReconnectInterval: 5000,
            logLevel: 'info',
            autoStartServers: true
        };
        
        this._setupEventHandlers();
        this._log('MCPUIManager initialized');
    }
    
    /**
     * Initialize all UI components
     * @returns {Promise<void>}
     */
    async initialize() {
        try {
            this._log('Initializing UI components');
            
            // Create output channel
            this._createOutputChannel();
            
            // Create status bar item
            this._createStatusBarItem();
            
            // Set up MCP dropdown provider
            this._setupMCPDropdownProvider();
            
            // Load configuration
            this._loadConfiguration();
            
            // Update initial UI state
            await this._updateUIState();
            
            this._log('UI components initialized successfully');
            this.emit('initialized');
            
        } catch (error) {
            this._log(`Failed to initialize UI components: ${error.message}`, 'error');
            throw error;
        }
    }
    
    /**
     * Update the status bar with current MCP server information
     */
    updateStatusBar() {
        if (!this.statusBarItem) return;
        
        const activeConnections = this.mcpServerManager.getActiveConnections();
        const activeCount = activeConnections.size;
        
        if (activeCount === 0) {
            this.statusBarItem.text = "$(server) MCP: No Connection";
            this.statusBarItem.tooltip = "Click to manage MCP servers";
            this.statusBarItem.backgroundColor = undefined;
        } else if (activeCount === 1) {
            const [serverId, client] = activeConnections.entries().next().value;
            const serverConfig = this.mcpServerManager.registry.getServer(serverId);
            const toolCount = client.getCachedTools().size;
            const protocolVersion = client.getNegotiatedVersion();
            
            this.statusBarItem.text = `$(server) MCP: ${serverConfig?.name || serverId}`;
            this.statusBarItem.tooltip = `${serverConfig?.name || serverId}\nProtocol version: ${protocolVersion || 'Unknown'}\nTools count: ${toolCount}\nClick to manage server`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        } else {
            let totalTools = 0;
            const versions = new Set();
            activeConnections.forEach(client => {
                totalTools += client.getCachedTools().size;
                const version = client.getNegotiatedVersion();
                if (version) versions.add(version);
            });
            
            const versionText = versions.size > 0 ? `\nProtocol version: ${Array.from(versions).join(', ')}` : '';
            this.statusBarItem.text = `$(server) MCP: ${activeCount} servers`;
            this.statusBarItem.tooltip = `Active servers: ${activeCount}\nTotal tools: ${totalTools}${versionText}\nClick to manage server`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        }
        
        this.statusBarItem.show();
    }
    
    /**
     * Show MCP server management quick pick
     */
    async showServerManagementQuickPick() {
        const servers = this.mcpServerManager.listServers();
        const activeConnections = this.mcpServerManager.getActiveConnections();
        
        const items = [];
        
        // Add header item
        items.push({
            label: `$(server) MCP Server Management (Installed: ${servers.length})`,
            kind: vscode.QuickPickItemKind.Separator
        });
        
        // Add server items
        for (const server of servers) {
            const isActive = activeConnections.has(server.id);
            const client = activeConnections.get(server.id);
            const toolCount = client ? client.getCachedTools().size : 0;
            const protocolVersion = client ? client.getNegotiatedVersion() : null;
            const versionCapabilities = client ? client.getVersionCapabilities() : null;
            
            let description = '';
            let detail = server.description || '';
            
            if (isActive) {
                const versionInfo = protocolVersion ? ` • v${protocolVersion}` : '';
                const deprecatedWarning = versionCapabilities?.isDeprecated ? ' ⚠️' : '';
                description = `$(check) Connected • ${toolCount} Tools${versionInfo}${deprecatedWarning}`;
                detail += detail ? ' • ' : '';
                detail += 'Click to disconnect';
                if (protocolVersion) {
                    detail += ` • 协议: ${protocolVersion}`;
                }
            } else {
                description = `$(circle-outline) Not connected`;
                detail += detail ? ' • ' : '';
                detail += 'Click to connect';
            }
            
            items.push({
                label: `$(extensions) ${server.name}`,
                description: description,
                detail: detail,
                serverId: server.id,
                isActive: isActive
            });
        }
        
        // Add management actions
        if (items.length > 1) {
            items.push({
                label: '',
                kind: vscode.QuickPickItemKind.Separator
            });
        }
        
        items.push(
            {
                label: `$(add) Install new server`,
                description: 'Install from URL or package name',
                action: 'install'
            },
            {
                label: `$(list-unordered) View all servers`,
                description: 'Show detailed server list',
                action: 'list'
            },
            {
                label: `$(settings-gear) MCP settings`,
                description: '配置MCP选项',
                action: 'settings'
            }
        );
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select operation or server',
            matchOnDescription: true,
            matchOnDetail: true
        });
        
        if (!selected) return;
        
        // Handle actions
        if (selected.action) {
            switch (selected.action) {
                case 'install':
                    await vscode.commands.executeCommand('vswizard.mcpInstall');
                    break;
                case 'list':
                    await vscode.commands.executeCommand('vswizard.mcpList');
                    break;
                case 'settings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'vswizard.mcp');
                    break;
            }
            return;
        }
        
        // Handle server actions
        if (selected.serverId) {
            if (selected.isActive) {
                await this.mcpServerManager.stopServer(selected.serverId);
            } else {
                await this.mcpServerManager.startServer(selected.serverId);
            }
        }
    }
    
    /**
     * Get MCP dropdown data for webview
     * @returns {Object} Dropdown data
     */
    getMCPDropdownData() {
        const servers = this.mcpServerManager.listServers();
        const activeConnections = this.mcpServerManager.getActiveConnections();
        
        return {
            servers: servers.map(server => {
                const isActive = activeConnections.has(server.id);
                const client = activeConnections.get(server.id);
                const toolCount = client ? client.getCachedTools().size : 0;
                const resourceCount = client ? client.getCachedResources().size : 0;
                const protocolVersion = client ? client.getNegotiatedVersion() : null;
                const versionCapabilities = client ? client.getVersionCapabilities() : null;
                
                return {
                    id: server.id,
                    name: server.name,
                    description: server.description,
                    isActive: isActive,
                    isSelected: this.selectedServers.has(server.id),
                    status: isActive ? 'connected' : 'disconnected',
                    toolCount: toolCount,
                    resourceCount: resourceCount,
                    protocolVersion: protocolVersion,
                    versionCapabilities: versionCapabilities,
                    versionInfo: {
                        isDeprecated: versionCapabilities?.isDeprecated || false,
                        isBackwardCompatible: false, // This would come from connection data
                        supportedFeatures: versionCapabilities ? Object.keys(versionCapabilities).filter(k => versionCapabilities[k] === true) : []
                    },
                    capabilities: {
                        tools: toolCount > 0,
                        resources: resourceCount > 0,
                        prompts: client ? client.getCachedPrompts().size > 0 : false
                    }
                };
            }),
            selectedCount: this.selectedServers.size,
            totalInstalled: servers.length,
            totalActive: activeConnections.size
        };
    }
    
    /**
     * Toggle server selection
     * @param {string} serverId - Server ID to toggle
     */
    toggleServerSelection(serverId) {
        if (this.selectedServers.has(serverId)) {
            this.selectedServers.delete(serverId);
        } else {
            this.selectedServers.add(serverId);
        }
        
        this.emit('serverSelectionChanged', {
            serverId,
            selected: this.selectedServers.has(serverId),
            selectedServers: Array.from(this.selectedServers)
        });
        
        this._updateUIState();
    }
    
    /**
     * Get selected servers
     * @returns {Array} Array of selected server IDs
     */
    getSelectedServers() {
        return Array.from(this.selectedServers);
    }
    
    /**
     * Clear server selection
     */
    clearServerSelection() {
        this.selectedServers.clear();
        this.emit('serverSelectionChanged', {
            selectedServers: []
        });
        this._updateUIState();
    }
    
    /**
     * Log message to MCP output channel
     * @param {string} message - Message to log
     * @param {string} level - Log level (info, warn, error, debug)
     */
    logToOutput(message, level = 'info') {
        if (!this.outputChannel) return;
        
        const timestamp = new Date().toLocaleTimeString();
        const levelTag = level.toUpperCase().padEnd(5);
        const logMessage = `[${timestamp}] [${levelTag}] ${message}`;
        
        this.outputChannel.appendLine(logMessage);
        
        // Auto-show output channel for errors
        if (level === 'error') {
            this.outputChannel.show(true);
        }
    }
    
    /**
     * Show MCP output channel
     */
    showOutputChannel() {
        if (this.outputChannel) {
            this.outputChannel.show();
        }
    }
    
    /**
     * Update configuration from VSCode settings
     */
    updateConfiguration() {
        this._loadConfiguration();
        this.emit('configurationUpdated', this.config);
    }
    
    /**
     * Dispose of all UI resources
     */
    dispose() {
        this._log('Disposing MCPUIManager');
        
        // Dispose status bar item
        if (this.statusBarItem) {
            this.statusBarItem.dispose();
            this.statusBarItem = null;
        }
        
        // Dispose output channel
        if (this.outputChannel) {
            this.outputChannel.dispose();
            this.outputChannel = null;
        }
        
        // Clear state
        this.activeServers.clear();
        this.selectedServers.clear();
        
        // Remove event listeners
        this.removeAllListeners();
        
        this._log('MCPUIManager disposed');
    }
    
    // Private methods
    
    /**
     * Set up event handlers for MCP server manager
     * @private
     */
    _setupEventHandlers() {
        // Server lifecycle events
        this.mcpServerManager.on('serverStarted', (serverId, client) => {
            const protocolVersion = client.getNegotiatedVersion();
            this.activeServers.set(serverId, {
                serverId,
                client,
                startTime: Date.now(),
                protocolVersion
            });
            this._updateUIState();
            this.logToOutput(`Server started: ${serverId} (Protocol version: ${protocolVersion || 'Unknown'})`, 'info');
        });
        
        this.mcpServerManager.on('serverStopped', (serverId) => {
            this.activeServers.delete(serverId);
            this._updateUIState();
            this.logToOutput(`Server stopped: ${serverId}`, 'info');
        });
        
        this.mcpServerManager.on('serverStartFailed', ({ serverId, error }) => {
            this._updateUIState();
            this.logToOutput(`Server start failed ${serverId}: ${error.message}`, 'error');
        });
        
        this.mcpServerManager.on('clientError', (serverId, error) => {
            this.logToOutput(`Client error ${serverId}: ${error.message}`, 'error');
        });
        
        this.mcpServerManager.on('clientReconnecting', (serverId, attempt) => {
            this.logToOutput(`Reconnecting ${serverId} (Attempt ${attempt})`, 'warn');
        });
        
        // Handle new debugging events
        this.mcpServerManager.on('nonJsonOutput', (serverId, output) => {
            if (this.config.logLevel === 'debug') {
                this.logToOutput(`Non-JSON output ${serverId}: ${output}`, 'debug');
            }
        });
        
        this.mcpServerManager.on('stderrOutput', (serverId, output) => {
            if (this.config.logLevel === 'debug') {
                this.logToOutput(`Standard error output ${serverId}: ${output}`, 'debug');
            }
        });
        
        // Installation events
        this.mcpServerManager.on('serverInstalled', (server) => {
            this.logToOutput(`Server installed: ${server.name} (${server.id})`, 'info');
            this._updateUIState();
        });
        
        this.mcpServerManager.on('installFailed', ({ url, error }) => {
            this.logToOutput(`Installation failed for ${url}: ${error.message}`, 'error');
        });
        
        // Version-related events
        this.mcpServerManager.on('versionNegotiated', (serverId, result) => {
            const statusText = result.isBackwardCompatible ? '(Backward compatible)' : '';
            const deprecatedText = result.isDeprecated ? '(Deprecated)' : '';
            this.logToOutput(`Version negotiation successful for ${serverId}: ${result.version} ${statusText}${deprecatedText}`, 'info');
        });
        
        this.mcpServerManager.on('versionWarning', (serverId, warning) => {
            this.logToOutput(`Version warning ${serverId}: ${warning.message}`, 'warn');
        });
        
        this.mcpServerManager.on('versionNegotiationError', (serverId, error) => {
            this.logToOutput(`Version negotiation failed for ${serverId}: ${error.message}`, 'error');
        });
        
        this.mcpServerManager.on('versionFallbackSuccess', (serverId, info) => {
            this.logToOutput(`Version fallback successful for ${serverId}: ${info.message}`, 'warn');
        });
        
        this.mcpServerManager.on('messageValidationWarning', (serverId, warning) => {
            if (this.config.logLevel === 'debug') {
                this.logToOutput(`Message verification warning for ${serverId}: ${warning.warnings.join(', ')}`, 'debug');
            }
        });
        
        this.mcpServerManager.on('messageValidationError', (serverId, error) => {
            this.logToOutput(`Message validation error ${serverId}: ${error.error}`, 'error');
        });
        
        // Tool/resource events
        this.mcpServerManager.on('toolCalled', (serverId, data) => {
            if (this.config.logLevel === 'debug') {
                this.logToOutput(`工具调用 ${serverId}: ${data.name}`, 'debug');
            }
        });
        
        this.mcpServerManager.on('resourceRead', (serverId, data) => {
            if (this.config.logLevel === 'debug') {
                this.logToOutput(`资源读取 ${serverId}: ${data.uri}`, 'debug');
            }
        });
    }
    
    /**
     * Create the MCP output channel
     * @private
     */
    _createOutputChannel() {
        this.outputChannel = vscode.window.createOutputChannel('MCP Server');
        this.logToOutput('MCP output channel created', 'info');
    }
    
    /**
     * Create the status bar item
     * @private
     */
    _createStatusBarItem() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        
        this.statusBarItem.command = 'vswizard.mcpShowQuickPick';
        this.statusBarItem.text = "$(server) MCP: 初始化中...";
        this.statusBarItem.tooltip = "MCP服务器管理";
        
        // Register the command
        const disposable = vscode.commands.registerCommand('vswizard.mcpShowQuickPick', () => {
            this.showServerManagementQuickPick();
        });
        
        this.context.subscriptions.push(disposable);
        this.context.subscriptions.push(this.statusBarItem);
    }
    
    /**
     * Set up MCP dropdown provider for webview integration
     * @private
     */
    _setupMCPDropdownProvider() {
        // This will be used by the webview to get MCP server data
        this.mcpDropdownProvider = {
            getData: () => this.getMCPDropdownData(),
            toggleSelection: (serverId) => this.toggleServerSelection(serverId),
            clearSelection: () => this.clearServerSelection(),
            connectServer: (serverId) => this.mcpServerManager.startServer(serverId),
            disconnectServer: (serverId) => this.mcpServerManager.stopServer(serverId),
            restartServer: (serverId) => this.mcpServerManager.restartServer(serverId)
        };
    }
    
    /**
     * Load configuration from VSCode settings
     * @private
     */
    _loadConfiguration() {
        const config = vscode.workspace.getConfiguration('vswizard.mcp');
        
        this.config = {
            connectionTimeout: config.get('connectionTimeout', 30000),
            retryCount: config.get('retryCount', 3),
            autoReconnectInterval: config.get('autoReconnectInterval', 5000),
            logLevel: config.get('logLevel', 'info'),
            autoStartServers: config.get('autoStartServers', true)
        };
    }
    
    /**
     * Update UI state based on current server status
     * @private
     */
    async _updateUIState() {
        // Update status bar
        this.updateStatusBar();
        
        // Emit state change event for webview updates
        this.emit('uiStateChanged', {
            dropdownData: this.getMCPDropdownData(),
            selectedServers: Array.from(this.selectedServers),
            activeServers: Array.from(this.activeServers.keys())
        });
    }
    
    /**
     * Log message with timestamp
     * @private
     */
    _log(message, level = 'info') {
        if (this.outputChannel) {
            this.logToOutput(message, level);
        } else {
            console.log(`[MCPUIManager] ${message}`);
        }
    }
}

module.exports = MCPUIManager;
