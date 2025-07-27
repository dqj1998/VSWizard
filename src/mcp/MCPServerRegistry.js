const { EventEmitter } = require('events');

/**
 * MCPServerRegistry - Manages persistent storage and metadata for MCP servers
 * Handles server configurations, status tracking, and registry operations
 */
class MCPServerRegistry extends EventEmitter {
    /**
     * Initialize the server registry
     * @param {vscode.ExtensionContext} context - VSCode extension context for storage
     */
    constructor(context) {
        super();
        
        this.context = context;
        this.servers = new Map();
        this.serverStatus = new Map();
        
        // Storage keys
        this.SERVERS_KEY = 'mcpServers';
        this.SERVER_STATUS_KEY = 'mcpServerStatus';
        
        // Load existing servers from storage
        this._loadServers();
        this._loadServerStatus();
    }
    
    /**
     * Add a new server to the registry
     * @param {Object} serverConfig - Server configuration
     * @param {string} serverConfig.id - Unique server identifier
     * @param {string} serverConfig.name - Human-readable server name
     * @param {string} serverConfig.command - Command to execute the server
     * @param {string[]} [serverConfig.args] - Command arguments
     * @param {Object} [serverConfig.env] - Environment variables
     * @param {string} [serverConfig.cwd] - Working directory
     * @param {string} [serverConfig.description] - Server description
     * @param {string} [serverConfig.version] - Server version
     * @param {string} [serverConfig.installMethod] - Installation method used
     * @param {string} [serverConfig.installUrl] - Original installation URL
     * @param {Object} [serverConfig.metadata] - Additional metadata
     * @returns {boolean} True if server was added successfully
     */
    addServer(serverConfig) {
        try {
            // Validate required fields
            if (!serverConfig.id || !serverConfig.name || !serverConfig.command) {
                throw new Error('Server configuration must include id, name, and command');
            }
            
            // Check for duplicate IDs
            if (this.servers.has(serverConfig.id)) {
                throw new Error(`Server with ID '${serverConfig.id}' already exists`);
            }
            
            // Create server entry with defaults
            const server = {
                id: serverConfig.id,
                name: serverConfig.name,
                command: serverConfig.command,
                args: serverConfig.args || [],
                env: serverConfig.env || {},
                cwd: serverConfig.cwd || process.cwd(),
                description: serverConfig.description || '',
                version: serverConfig.version || 'unknown',
                installMethod: serverConfig.installMethod || 'manual',
                installUrl: serverConfig.installUrl || '',
                metadata: serverConfig.metadata || {},
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            
            // Add to registry
            this.servers.set(server.id, server);
            this.serverStatus.set(server.id, {
                status: 'stopped',
                lastStarted: null,
                lastStopped: null,
                restartCount: 0,
                errorCount: 0,
                lastError: null
            });
            
            // Persist to storage
            this._saveServers();
            this._saveServerStatus();
            
            this.emit('serverAdded', server);
            return true;
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Remove a server from the registry
     * @param {string} serverId - Server ID to remove
     * @returns {boolean} True if server was removed successfully
     */
    removeServer(serverId) {
        try {
            if (!this.servers.has(serverId)) {
                throw new Error(`Server with ID '${serverId}' not found`);
            }
            
            const server = this.servers.get(serverId);
            this.servers.delete(serverId);
            this.serverStatus.delete(serverId);
            
            // Persist changes
            this._saveServers();
            this._saveServerStatus();
            
            this.emit('serverRemoved', server);
            return true;
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Update server configuration
     * @param {string} serverId - Server ID to update
     * @param {Object} updates - Configuration updates
     * @returns {boolean} True if server was updated successfully
     */
    updateServer(serverId, updates) {
        try {
            if (!this.servers.has(serverId)) {
                throw new Error(`Server with ID '${serverId}' not found`);
            }
            
            const server = this.servers.get(serverId);
            const updatedServer = {
                ...server,
                ...updates,
                id: server.id, // Prevent ID changes
                updatedAt: new Date().toISOString()
            };
            
            this.servers.set(serverId, updatedServer);
            this._saveServers();
            
            this.emit('serverUpdated', updatedServer);
            return true;
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Get server configuration by ID
     * @param {string} serverId - Server ID
     * @returns {Object|null} Server configuration or null if not found
     */
    getServer(serverId) {
        return this.servers.get(serverId) || null;
    }
    
    /**
     * Check if a server exists
     * @param {string} serverId - Server ID to check
     * @returns {boolean} True if server exists
     */
    hasServer(serverId) {
        return this.servers.has(serverId);
    }
    
    /**
     * Add or update a server (replaces existing server if it exists)
     * @param {Object} serverConfig - Server configuration
     * @param {boolean} [overwrite=false] - Whether to overwrite existing server
     * @returns {boolean} True if server was added/updated successfully
     */
    addOrUpdateServer(serverConfig, overwrite = false) {
        try {
            // Validate required fields
            if (!serverConfig.id || !serverConfig.name || !serverConfig.command) {
                throw new Error('Server configuration must include id, name, and command');
            }
            
            // Check for duplicate IDs
            if (this.servers.has(serverConfig.id)) {
                if (!overwrite) {
                    throw new Error(`Server with ID '${serverConfig.id}' already exists. Use overwrite=true to replace it.`);
                }
                // Remove existing server first
                this.removeServer(serverConfig.id);
            }
            
            // Add the server
            return this.addServer(serverConfig);
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }
    
    /**
     * Get all registered servers
     * @returns {Array} Array of server configurations
     */
    getAllServers() {
        return Array.from(this.servers.values());
    }
    
    /**
     * Get servers by installation method
     * @param {string} method - Installation method (npm, pip, git, manual)
     * @returns {Array} Array of matching servers
     */
    getServersByMethod(method) {
        return this.getAllServers().filter(server => server.installMethod === method);
    }
    
    /**
     * Update server status
     * @param {string} serverId - Server ID
     * @param {string} status - New status (starting, running, stopping, stopped, error)
     * @param {Object} [details] - Additional status details
     */
    updateServerStatus(serverId, status, details = {}) {
        try {
            if (!this.servers.has(serverId)) {
                throw new Error(`Server with ID '${serverId}' not found`);
            }
            
            const currentStatus = this.serverStatus.get(serverId) || {};
            const updatedStatus = {
                ...currentStatus,
                status,
                ...details,
                lastUpdated: new Date().toISOString()
            };
            
            // Update specific timestamps based on status
            if (status === 'running') {
                updatedStatus.lastStarted = new Date().toISOString();
            } else if (status === 'stopped') {
                updatedStatus.lastStopped = new Date().toISOString();
            } else if (status === 'error') {
                updatedStatus.errorCount = (updatedStatus.errorCount || 0) + 1;
                updatedStatus.lastError = details.error || 'Unknown error';
            }
            
            this.serverStatus.set(serverId, updatedStatus);
            this._saveServerStatus();
            
            this.emit('serverStatusChanged', serverId, status, updatedStatus);
            
        } catch (error) {
            this.emit('error', error);
        }
    }
    
    /**
     * Get server status
     * @param {string} serverId - Server ID
     * @returns {Object|null} Server status or null if not found
     */
    getServerStatus(serverId) {
        return this.serverStatus.get(serverId) || null;
    }
    
    /**
     * Get all server statuses
     * @returns {Map} Map of server ID to status
     */
    getAllServerStatuses() {
        return new Map(this.serverStatus);
    }
    
    /**
     * Export server configurations
     * @param {string[]} [serverIds] - Specific server IDs to export (all if not specified)
     * @returns {Object} Exported configuration
     */
    exportServers(serverIds = null) {
        const serversToExport = serverIds 
            ? serverIds.map(id => this.servers.get(id)).filter(Boolean)
            : this.getAllServers();
            
        return {
            version: '1.0.0',
            exportedAt: new Date().toISOString(),
            servers: serversToExport
        };
    }
    
    /**
     * Import server configurations
     * @param {Object} exportData - Exported configuration data
     * @param {boolean} [overwrite=false] - Whether to overwrite existing servers
     * @returns {Object} Import results
     */
    importServers(exportData, overwrite = false) {
        const results = {
            imported: 0,
            skipped: 0,
            errors: []
        };
        
        try {
            if (!exportData.servers || !Array.isArray(exportData.servers)) {
                throw new Error('Invalid export data format');
            }
            
            for (const serverConfig of exportData.servers) {
                try {
                    if (this.servers.has(serverConfig.id) && !overwrite) {
                        results.skipped++;
                        continue;
                    }
                    
                    if (this.servers.has(serverConfig.id) && overwrite) {
                        this.removeServer(serverConfig.id);
                    }
                    
                    if (this.addServer(serverConfig)) {
                        results.imported++;
                    } else {
                        results.errors.push(`Failed to import server: ${serverConfig.id}`);
                    }
                    
                } catch (error) {
                    results.errors.push(`Error importing server ${serverConfig.id}: ${error.message}`);
                }
            }
            
        } catch (error) {
            results.errors.push(`Import error: ${error.message}`);
        }
        
        return results;
    }
    
    /**
     * Validate server configuration
     * @param {Object} serverConfig - Server configuration to validate
     * @returns {Object} Validation result
     */
    validateServerConfig(serverConfig) {
        const errors = [];
        const warnings = [];
        
        // Required fields
        if (!serverConfig.id) errors.push('Server ID is required');
        if (!serverConfig.name) errors.push('Server name is required');
        if (!serverConfig.command) errors.push('Server command is required');
        
        // ID format validation
        if (serverConfig.id && !/^[a-zA-Z0-9_-]+$/.test(serverConfig.id)) {
            errors.push('Server ID must contain only alphanumeric characters, underscores, and hyphens');
        }
        
        // Command validation
        if (serverConfig.command && typeof serverConfig.command !== 'string') {
            errors.push('Server command must be a string');
        }
        
        // Args validation
        if (serverConfig.args && !Array.isArray(serverConfig.args)) {
            errors.push('Server args must be an array');
        }
        
        // Environment validation
        if (serverConfig.env && typeof serverConfig.env !== 'object') {
            errors.push('Server environment must be an object');
        }
        
        // Warnings for optional but recommended fields
        if (!serverConfig.description) warnings.push('Server description is recommended');
        if (!serverConfig.version) warnings.push('Server version is recommended');
        
        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }
    
    /**
     * Clear all servers (for testing/reset)
     * @returns {boolean} True if cleared successfully
     */
    clearAll() {
        try {
            this.servers.clear();
            this.serverStatus.clear();
            this._saveServers();
            this._saveServerStatus();
            
            this.emit('registryCleared');
            return true;
            
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }
    
    // Private methods
    
    /**
     * Load servers from persistent storage
     * @private
     */
    _loadServers() {
        try {
            const storedServers = this.context.globalState.get(this.SERVERS_KEY, {});
            this.servers = new Map(Object.entries(storedServers));
        } catch (error) {
            this.emit('error', new Error(`Failed to load servers: ${error.message}`));
            this.servers = new Map();
        }
    }
    
    /**
     * Save servers to persistent storage
     * @private
     */
    _saveServers() {
        try {
            const serversObject = Object.fromEntries(this.servers);
            this.context.globalState.update(this.SERVERS_KEY, serversObject);
        } catch (error) {
            this.emit('error', new Error(`Failed to save servers: ${error.message}`));
        }
    }
    
    /**
     * Load server status from persistent storage
     * @private
     */
    _loadServerStatus() {
        try {
            const storedStatus = this.context.globalState.get(this.SERVER_STATUS_KEY, {});
            this.serverStatus = new Map(Object.entries(storedStatus));
        } catch (error) {
            this.emit('error', new Error(`Failed to load server status: ${error.message}`));
            this.serverStatus = new Map();
        }
    }
    
    /**
     * Save server status to persistent storage
     * @private
     */
    _saveServerStatus() {
        try {
            const statusObject = Object.fromEntries(this.serverStatus);
            this.context.globalState.update(this.SERVER_STATUS_KEY, statusObject);
        } catch (error) {
            this.emit('error', new Error(`Failed to save server status: ${error.message}`));
        }
    }
}

module.exports = MCPServerRegistry;