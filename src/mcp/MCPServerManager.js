const { EventEmitter } = require('events');
const MCPClient = require('./MCPClient');
const MCPEnhancedInstaller = require('./MCPEnhancedInstaller');
const MCPServerRegistry = require('./MCPServerRegistry');

/**
 * MCPServerManager - Main orchestration class for MCP server management
 * Handles server lifecycle, installation, and client connections
 */
class MCPServerManager extends EventEmitter {
    /**
     * Initialize the server manager
     * @param {Object} context - VSCode extension context
     * @param {Object} outputChannel - VSCode output channel for logging
     */
    constructor(context, outputChannel) {
        super();
        
        this.context = context;
        this.outputChannel = outputChannel;
        
        // Initialize components
        this.registry = new MCPServerRegistry(context);
        this.installer = new MCPEnhancedInstaller(outputChannel, {
            securityChecks: true,
            autoRetry: true,
            maxRetries: 3
        });
        // Keep reference for backward compatibility
        this.enhancedInstaller = this.installer;
        
        // Active connections
        this.activeClients = new Map(); // serverId -> MCPClient
        this.connectionAttempts = new Map(); // serverId -> attempt count
        
        // Configuration
        this.maxReconnectAttempts = 3;
        this.reconnectDelay = 2000;
        
        // Set up event handlers
        this._setupEventHandlers();
        
        this._log('MCPServerManager initialized with enhanced installer');
    }
    
    /**
     * Install a server from URL with enhanced capabilities
     * @param {string} url - Installation URL or package name
     * @param {Object} [options] - Installation options
     * @param {Function} [options.onProgress] - Progress callback
     * @param {boolean} [options.autoStart] - Start server after installation
     * @param {boolean} [options.useEnhanced] - Use enhanced installer (default: true)
     * @returns {Promise<Object>} Installation result with server configuration
     */
    async installServer(url, options = {}) {
        try {
            this._log(`Installing server from: ${url}`);
            this.emit('installStarted', { url, options });
            
            // Always use the enhanced installer (which now includes legacy compatibility)
            this._log(`Using enhanced installer with legacy compatibility`);
            
            // Install the server
            const installResult = await this.installer.installServer(url, {
                onProgress: options.onProgress
            });
            
            // Create server configuration for registry
            const serverConfig = {
                id: installResult.id,
                name: installResult.name,
                description: installResult.description,
                version: installResult.version,
                command: installResult.command,
                args: installResult.args,
                cwd: installResult.cwd,
                env: installResult.env,
                installMethod: installResult.installMethod,
                installUrl: installResult.installUrl,
                metadata: {
                    installPath: installResult.installPath,
                    packageInfo: installResult.packageInfo,
                    setupMethod: installResult.setupMethod
                }
            };
            
            // Add to registry (with option to overwrite if exists)
            if (!this.registry.addOrUpdateServer(serverConfig, false)) {
                // If it fails due to duplicate ID, suggest using uninstall first
                if (this.registry.hasServer(serverConfig.id)) {
                    throw new Error(`Server with ID '${serverConfig.id}' already exists. Please uninstall it first using the 'wzd: Uninstall MCP Server' command, then try installing again.`);
                }
                throw new Error('Failed to add server to registry');
            }
            
            this._log(`Server installed successfully: ${serverConfig.id}`);
            this.emit('serverInstalled', serverConfig);
            
            // Auto-start if requested
            if (options.autoStart) {
                await this.startServer(serverConfig.id);
            }
            
            return serverConfig;
            
        } catch (error) {
            this._log(`Server installation failed: ${error.message}`, 'error');
            this.emit('installFailed', { url, error });
            throw error;
        }
    }
    
    /**
     * Uninstall a server with enhanced cleanup
     * @param {string} serverId - Server ID to uninstall
     * @returns {Promise<boolean>} True if uninstalled successfully
     */
    async uninstallServer(serverId) {
        try {
            this._log(`Uninstalling server: ${serverId}`);
            
            const serverConfig = this.registry.getServer(serverId);
            if (!serverConfig) {
                throw new Error(`Server not found: ${serverId}`);
            }
            
            // Stop server if running
            if (this.activeClients.has(serverId)) {
                await this.stopServer(serverId);
            }
            
            // Use the enhanced installer (which handles both legacy and enhanced installations)
            this._log(`Using enhanced uninstaller with legacy compatibility`);
            
            // Uninstall files
            await this.installer.uninstallServer(serverConfig);
            
            // Remove from registry
            if (!this.registry.removeServer(serverId)) {
                throw new Error('Failed to remove server from registry');
            }
            
            this._log(`Server uninstalled successfully: ${serverId}`);
            this.emit('serverUninstalled', serverId);
            
            return true;
            
        } catch (error) {
            this._log(`Server uninstall failed: ${error.message}`, 'error');
            this.emit('uninstallFailed', { serverId, error });
            throw error;
        }
    }
    
    /**
     * Start a server
     * @param {string} serverId - Server ID to start
     * @returns {Promise<MCPClient>} Connected MCP client
     */
    async startServer(serverId) {
        try {
            this._log(`Starting server: ${serverId}`);
            
            const serverConfig = this.registry.getServer(serverId);
            if (!serverConfig) {
                throw new Error(`Server not found: ${serverId}`);
            }
            
            // Check if already running
            if (this.activeClients.has(serverId)) {
                const client = this.activeClients.get(serverId);
                if (client.isConnected()) {
                    this._log(`Server already running: ${serverId}`);
                    return client;
                }
                // Clean up stale client
                await this._cleanupClient(serverId);
            }
            
            // Update status
            this.registry.updateServerStatus(serverId, 'starting');
            this.emit('serverStarting', serverId);
            
            // Create and configure client
            const client = new MCPClient({
                command: serverConfig.command,
                args: serverConfig.args,
                env: serverConfig.env,
                cwd: serverConfig.cwd,
                name: serverConfig.name,
                timeout: 30000
            });
            
            // Set up client event handlers
            this._setupClientEventHandlers(serverId, client);
            
            // Connect to server
            const connectionResult = await client.connect();
            
            // Store active client
            this.activeClients.set(serverId, client);
            this.connectionAttempts.delete(serverId);
            
            // Update status with version information
            this.registry.updateServerStatus(serverId, 'running', {
                pid: client.process?.pid,
                serverInfo: client.getServerInfo(),
                protocolVersion: client.getNegotiatedVersion(),
                versionCapabilities: client.getVersionCapabilities(),
                connectionTime: new Date().toISOString()
            });
            
            this._log(`Server started successfully: ${serverId}`);
            this.emit('serverStarted', serverId, client);
            
            return client;
            
        } catch (error) {
            this.registry.updateServerStatus(serverId, 'error', { error: error.message });
            this._log(`Server start failed: ${error.message}`, 'error');
            this.emit('serverStartFailed', { serverId, error });
            throw error;
        }
    }
    
    /**
     * Stop a server
     * @param {string} serverId - Server ID to stop
     * @returns {Promise<boolean>} True if stopped successfully
     */
    async stopServer(serverId) {
        try {
            this._log(`Stopping server: ${serverId}`);
            
            const client = this.activeClients.get(serverId);
            if (!client) {
                this._log(`Server not running: ${serverId}`);
                return true;
            }
            
            // Update status
            this.registry.updateServerStatus(serverId, 'stopping');
            this.emit('serverStopping', serverId);
            
            // Disconnect client
            await client.disconnect();
            
            // Clean up
            await this._cleanupClient(serverId);
            
            // Update status
            this.registry.updateServerStatus(serverId, 'stopped');
            
            this._log(`Server stopped successfully: ${serverId}`);
            this.emit('serverStopped', serverId);
            
            return true;
            
        } catch (error) {
            this._log(`Server stop failed: ${error.message}`, 'error');
            this.emit('serverStopFailed', { serverId, error });
            throw error;
        }
    }
    
    /**
     * Restart a server
     * @param {string} serverId - Server ID to restart
     * @returns {Promise<MCPClient>} Connected MCP client
     */
    async restartServer(serverId) {
        try {
            this._log(`Restarting server: ${serverId}`);
            
            // Stop if running
            if (this.activeClients.has(serverId)) {
                await this.stopServer(serverId);
            }
            
            // Wait a moment before restarting
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Start again
            const client = await this.startServer(serverId);
            
            // Update restart count
            const status = this.registry.getServerStatus(serverId);
            this.registry.updateServerStatus(serverId, 'running', {
                restartCount: (status?.restartCount || 0) + 1
            });
            
            this._log(`Server restarted successfully: ${serverId}`);
            this.emit('serverRestarted', serverId, client);
            
            return client;
            
        } catch (error) {
            this._log(`Server restart failed: ${error.message}`, 'error');
            this.emit('serverRestartFailed', { serverId, error });
            throw error;
        }
    }
    
    /**
     * Get list of all servers
     * @returns {Array} Array of server configurations
     */
    listServers() {
        return this.registry.getAllServers();
    }
    
    /**
     * Get server status
     * @param {string} serverId - Server ID
     * @returns {Object|null} Server status or null if not found
     */
    getServerStatus(serverId) {
        const registryStatus = this.registry.getServerStatus(serverId);
        const isConnected = this.activeClients.has(serverId) &&
                           this.activeClients.get(serverId).isConnected();
        const client = isConnected ? this.activeClients.get(serverId) : null;
        
        return {
            ...registryStatus,
            connected: isConnected,
            client: client,
            protocolVersion: client ? client.getNegotiatedVersion() : null,
            versionCapabilities: client ? client.getVersionCapabilities() : null,
            versionInfo: client ? this._getVersionInfo(client) : null
        };
    }
    
    /**
     * Get active MCP client for a server
     * @param {string} serverId - Server ID
     * @returns {MCPClient|null} Active client or null if not running
     */
    getClient(serverId) {
        const client = this.activeClients.get(serverId);
        return (client && client.isConnected()) ? client : null;
    }
    
    /**
     * Update server configuration
     * @param {string} serverId - Server ID
     * @param {Object} updates - Configuration updates
     * @returns {boolean} True if updated successfully
     */
    updateServerConfig(serverId, updates) {
        const success = this.registry.updateServer(serverId, updates);
        if (success) {
            this.emit('serverConfigUpdated', serverId, updates);
        }
        return success;
    }
    
    /**
     * Get all active connections
     * @returns {Map} Map of server ID to MCPClient
     */
    getActiveConnections() {
        const activeConnections = new Map();
        for (const [serverId, client] of this.activeClients) {
            if (client.isConnected()) {
                activeConnections.set(serverId, client);
            }
        }
        return activeConnections;
    }
    
    /**
     * Start all servers marked for auto-start
     * @returns {Promise<Array>} Array of start results
     */
    async startAutoStartServers() {
        const servers = this.registry.getAllServers();
        const autoStartServers = servers.filter(server => 
            server.metadata?.autoStart === true
        );
        
        const results = [];
        for (const server of autoStartServers) {
            try {
                const client = await this.startServer(server.id);
                results.push({ serverId: server.id, success: true, client });
            } catch (error) {
                results.push({ serverId: server.id, success: false, error });
            }
        }
        
        return results;
    }
    
    /**
     * Stop all running servers
     * @returns {Promise<Array>} Array of stop results
     */
    async stopAllServers() {
        const results = [];
        const activeServerIds = Array.from(this.activeClients.keys());
        
        for (const serverId of activeServerIds) {
            try {
                await this.stopServer(serverId);
                results.push({ serverId, success: true });
            } catch (error) {
                results.push({ serverId, success: false, error });
            }
        }
        
        return results;
    }
    
    /**
     * Get server health status
     * @param {string} serverId - Server ID
     * @returns {Object} Health status information
     */
    async getServerHealth(serverId) {
        const client = this.getClient(serverId);
        if (!client) {
            return {
                healthy: false,
                status: 'not_running',
                message: 'Server is not running'
            };
        }
        
        try {
            // Try to list tools as a health check
            await client.listTools();
            return {
                healthy: true,
                status: 'running',
                message: 'Server is responding normally',
                serverInfo: client.getServerInfo(),
                protocolVersion: client.getNegotiatedVersion(),
                versionCapabilities: client.getVersionCapabilities(),
                capabilities: {
                    tools: client.getCachedTools().size,
                    resources: client.getCachedResources().size,
                    prompts: client.getCachedPrompts().size
                }
            };
        } catch (error) {
            return {
                healthy: false,
                status: 'error',
                message: `Server health check failed: ${error.message}`,
                error: error.message
            };
        }
    }
    
    /**
     * Update server from source
     * @param {string} serverId - Server ID to update
     * @param {Object} [options] - Update options
     * @returns {Promise<Object>} Updated server configuration
     */
    async updateServer(serverId, options = {}) {
        try {
            this._log(`Updating server: ${serverId}`);
            
            const serverConfig = this.registry.getServer(serverId);
            if (!serverConfig) {
                throw new Error(`Server not found: ${serverId}`);
            }
            
            // Stop server if running
            if (this.activeClients.has(serverId)) {
                await this.stopServer(serverId);
            }
            
            // Use enhanced installer for updates (which has updateServer method)
            if (this.installer.updateServer) {
                // Use enhanced update method
                const updatedConfig = await this.installer.updateServer(serverConfig, options);
                
                // Update registry
                this.registry.updateServer(serverId, updatedConfig);
                
                this._log(`Server updated successfully: ${serverId}`);
                this.emit('serverUpdated', serverId, updatedConfig);
                
                return updatedConfig;
            } else {
                // Fallback to reinstall
                await this.uninstallServer(serverId);
                return await this.installServer(serverConfig.installUrl, {
                    ...options,
                    autoStart: false
                });
            }
            
        } catch (error) {
            this._log(`Server update failed: ${error.message}`, 'error');
            this.emit('updateFailed', { serverId, error });
            throw error;
        }
    }
    
    /**
     * Clear installation cache
     * @param {Object} [options] - Clear options
     * @returns {Promise<boolean>} True if cleared successfully
     */
    async clearCache(options = {}) {
        try {
            this._log('Clearing installation cache');
            
            // Clear installer cache
            if (this.installer.clearCache) {
                await this.installer.clearCache(options);
            }
            
            this._log('Cache cleared successfully');
            this.emit('cacheCleared', options);
            
            return true;
            
        } catch (error) {
            this._log(`Cache clear failed: ${error.message}`, 'error');
            this.emit('cacheClearFailed', { error });
            throw error;
        }
    }
    
    /**
     * Get installation status
     * @param {string} serverId - Server ID
     * @returns {Object} Installation status
     */
    getInstallationStatus(serverId) {
        const serverConfig = this.registry.getServer(serverId);
        if (!serverConfig) {
            return null;
        }
        
        let installationStatus = null;
        
        if (this.installer.getInstallationStatus) {
            const installId = serverConfig.metadata?.installId;
            if (installId) {
                installationStatus = this.installer.getInstallationStatus(installId);
            }
        }
        
        return {
            serverId,
            installMethod: serverConfig.installMethod || 'enhanced',
            installationStatus,
            serverStatus: this.getServerStatus(serverId)
        };
    }
    
    /**
     * Dispose of all resources
     */
    async dispose() {
        this._log('Disposing MCPServerManager');
        
        // Stop all servers
        await this.stopAllServers();
        
        // Remove event listeners
        this.registry.removeAllListeners();
        this.installer.removeAllListeners();
        this.removeAllListeners();
        
        this._log('MCPServerManager disposed');
    }
    
    // Private methods
    
    /**
     * Set up event handlers for components
     * @private
     */
    _setupEventHandlers() {
        // Registry events
        this.registry.on('serverAdded', (server) => {
            this.emit('serverRegistered', server);
        });
        
        this.registry.on('serverRemoved', (server) => {
            this.emit('serverDeregistered', server);
        });
        
        this.registry.on('serverStatusChanged', (serverId, status, details) => {
            this.emit('serverStatusChanged', serverId, status, details);
        });
        
        this.registry.on('error', (error) => {
            this._log(`Registry error: ${error.message}`, 'error');
            this.emit('error', error);
        });
        
        // Enhanced installer events (now the only installer)
        this.installer.on('installStarted', (data) => {
            this.emit('installProgress', { ...data, stage: 'started' });
            this.emit('enhancedInstallStarted', data);
        });
        
        this.installer.on('installProgress', (data) => {
            this.emit('enhancedInstallProgress', data);
        });
        
        this.installer.on('installCompleted', (result) => {
            this.emit('installProgress', { ...result, stage: 'completed' });
            this.emit('enhancedInstallCompleted', result);
        });
        
        this.installer.on('installFailed', (data) => {
            this.emit('installProgress', { ...data, stage: 'failed' });
            this.emit('enhancedInstallFailed', data);
        });
        
        this.installer.on('uninstallStarted', (serverConfig) => {
            this.emit('enhancedUninstallStarted', serverConfig);
        });
        
        this.installer.on('uninstallCompleted', (serverConfig) => {
            this.emit('enhancedUninstallCompleted', serverConfig);
        });
        
        this.installer.on('uninstallFailed', (data) => {
            this.emit('enhancedUninstallFailed', data);
        });
        
        this.installer.on('log', (logData) => {
            this.emit('installerLog', logData);
            this.emit('enhancedInstallerLog', logData);
        });
        
        this.installer.on('error', (error) => {
            this._log(`Installer error: ${error.message}`, 'error');
            this.emit('error', error);
        });
    }
    
    /**
     * Set up event handlers for a client
     * @private
     */
    _setupClientEventHandlers(serverId, client) {
        client.on('connected', (connectionData) => {
            const { serverInfo, negotiatedVersion, versionCapabilities } = connectionData;
            this._log(`Client connected: ${serverId} (Protocol: ${negotiatedVersion})`);
            this.emit('clientConnected', serverId, {
                serverInfo,
                negotiatedVersion,
                versionCapabilities
            });
        });
        
        client.on('disconnected', () => {
            this._log(`Client disconnected: ${serverId}`);
            this.registry.updateServerStatus(serverId, 'stopped');
            this.emit('clientDisconnected', serverId);
        });
        
        client.on('error', (error) => {
            this._log(`Client error for ${serverId}: ${error.message}`, 'error');
            this.registry.updateServerStatus(serverId, 'error', { error: error.message });
            this.emit('clientError', serverId, error);
            
            // Attempt reconnection
            this._attemptReconnection(serverId);
        });
        
        client.on('reconnecting', (attempt) => {
            this._log(`Client reconnecting: ${serverId} (attempt ${attempt})`);
            this.registry.updateServerStatus(serverId, 'reconnecting');
            this.emit('clientReconnecting', serverId, attempt);
        });
        
        // Version-related events
        client.on('versionNegotiated', (result) => {
            this._log(`Version negotiated for ${serverId}: ${result.version}` +
                     (result.isBackwardCompatible ? ' (backward compatible)' : '') +
                     (result.isDeprecated ? ' (deprecated)' : ''));
            this.emit('versionNegotiated', serverId, result);
        });
        
        client.on('versionWarning', (warning) => {
            this._log(`Version warning for ${serverId}: ${warning.message}`, 'warn');
            this.emit('versionWarning', serverId, warning);
        });
        
        client.on('versionNegotiationWarning', (warning) => {
            this._log(`Version negotiation warning for ${serverId}: ${warning.message}`, 'warn');
            this.emit('versionNegotiationWarning', serverId, warning);
        });
        
        client.on('versionNegotiationError', (error) => {
            this._log(`Version negotiation error for ${serverId}: ${error.message}`, 'error');
            this.emit('versionNegotiationError', serverId, error);
        });
        
        client.on('versionFallbackSuccess', (info) => {
            this._log(`Version fallback success for ${serverId}: ${info.message}`, 'warn');
            this.emit('versionFallbackSuccess', serverId, info);
        });
        
        client.on('versionFallbackAttempt', (attempt) => {
            this._log(`Version fallback attempt for ${serverId}: ${attempt.version} - ${attempt.error}`, 'warn');
            this.emit('versionFallbackAttempt', serverId, attempt);
        });
        
        client.on('messageValidationWarning', (warning) => {
            if (this._shouldLogValidationWarning(warning)) {
                this._log(`Message validation warning for ${serverId}: ${warning.warnings.join(', ')}`, 'warn');
            }
            this.emit('messageValidationWarning', serverId, warning);
        });
        
        client.on('messageValidationError', (error) => {
            this._log(`Message validation error for ${serverId}: ${error.error}`, 'error');
            this.emit('messageValidationError', serverId, error);
        });
        
        // Forward debugging events
        client.on('nonJsonOutput', (output) => {
            this.emit('nonJsonOutput', serverId, output);
        });
        
        client.on('stderrOutput', (output) => {
            this.emit('stderrOutput', serverId, output);
        });
        
        // Forward tool/resource events
        client.on('toolCalled', (data) => {
            this.emit('toolCalled', serverId, data);
        });
        
        client.on('resourceRead', (data) => {
            this.emit('resourceRead', serverId, data);
        });
        
        client.on('promptRetrieved', (data) => {
            this.emit('promptRetrieved', serverId, data);
        });
    }
    
    /**
     * Clean up a client connection
     * @private
     */
    async _cleanupClient(serverId) {
        const client = this.activeClients.get(serverId);
        if (client) {
            try {
                client.removeAllListeners();
                if (client.isConnected()) {
                    await client.disconnect();
                }
            } catch (error) {
                this._log(`Error cleaning up client ${serverId}: ${error.message}`, 'warn');
            }
            this.activeClients.delete(serverId);
        }
    }
    
    /**
     * Attempt to reconnect a failed client
     * @private
     */
    async _attemptReconnection(serverId) {
        const attempts = this.connectionAttempts.get(serverId) || 0;
        
        if (attempts >= this.maxReconnectAttempts) {
            this._log(`Max reconnection attempts reached for ${serverId}`, 'warn');
            this.registry.updateServerStatus(serverId, 'error', {
                error: 'Max reconnection attempts exceeded'
            });
            return;
        }
        
        // Check if server is already being restarted or is running
        const client = this.activeClients.get(serverId);
        if (client && client.isConnected()) {
            this._log(`Server ${serverId} is already connected, skipping reconnection`);
            return;
        }
        
        const status = this.registry.getServerStatus(serverId);
        if (status && (status.status === 'starting' || status.status === 'running')) {
            this._log(`Server ${serverId} is already ${status.status}, skipping reconnection`);
            return;
        }
        
        this.connectionAttempts.set(serverId, attempts + 1);
        
        setTimeout(async () => {
            try {
                // Double-check status before attempting restart
                const currentStatus = this.registry.getServerStatus(serverId);
                if (currentStatus && currentStatus.status === 'running') {
                    this._log(`Server ${serverId} is now running, cancelling reconnection`);
                    this.connectionAttempts.delete(serverId);
                    return;
                }
                
                this._log(`Attempting reconnection for ${serverId} (${attempts + 1}/${this.maxReconnectAttempts})`);
                await this.restartServer(serverId);
                this.connectionAttempts.delete(serverId);
            } catch (error) {
                this._log(`Reconnection failed for ${serverId}: ${error.message}`, 'error');
            }
        }, this.reconnectDelay * (attempts + 1));
    }
    
    /**
     * Get version information for a client
     * @private
     */
    _getVersionInfo(client) {
        const negotiatedVersion = client.getNegotiatedVersion();
        const versionCapabilities = client.getVersionCapabilities();
        const versionManager = client.getVersionManager();
        
        if (!negotiatedVersion || !versionManager) {
            return null;
        }
        
        try {
            const versionInfo = versionManager.getVersionInfo(negotiatedVersion);
            return {
                ...versionInfo,
                negotiatedAt: new Date().toISOString(),
                supportedVersions: versionManager.getSupportedVersions(),
                isOptimal: negotiatedVersion === versionManager.currentVersion
            };
        } catch (error) {
            return {
                version: negotiatedVersion,
                error: error.message,
                capabilities: versionCapabilities
            };
        }
    }
    
    /**
     * Check if validation warning should be logged (to avoid spam)
     * @private
     */
    _shouldLogValidationWarning(warning) {
        // Only log validation warnings for certain methods or at intervals
        const method = warning.method;
        const suppressedMethods = new Set(['tools/list', 'resources/list', 'prompts/list']);
        
        // Don't log warnings for frequently called methods
        if (suppressedMethods.has(method)) {
            return false;
        }
        
        // Log other warnings
        return true;
    }
    
    /**
     * Log message to output channel
     * @private
     */
    _log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [MCPServerManager] [${level.toUpperCase()}] ${message}`;
        
        if (this.outputChannel) {
            this.outputChannel.appendLine(logMessage);
        } else {
            console.log(logMessage);
        }
        
        this.emit('log', { message, level, timestamp });
    }
}

module.exports = MCPServerManager;