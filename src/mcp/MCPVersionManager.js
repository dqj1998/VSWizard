const { EventEmitter } = require('events');

/**
 * MCPVersionManager - Protocol version management for MCP communication
 * Handles version negotiation, compatibility checking, and graceful fallbacks
 */
class MCPVersionManager extends EventEmitter {
    /**
     * Initialize the version manager with supported protocol versions
     */
    constructor() {
        super();
        
        // Supported MCP protocol versions in order of preference (newest first)
        this.supportedVersions = [
            '2024-11-05',
            '2024-10-07',
            '2024-09-24'
        ];
        
        // Current protocol version (default/preferred)
        this.currentVersion = '2024-11-05';
        
        // Version compatibility matrix
        this.compatibilityMatrix = {
            '2024-11-05': {
                features: {
                    tools: true,
                    resources: true,
                    prompts: true,
                    sampling: true,
                    roots: true,
                    notifications: true,
                    progress: true,
                    cancellation: true
                },
                messageFormats: {
                    initialize: 'v2024-11-05',
                    tools: 'v2024-11-05',
                    resources: 'v2024-11-05',
                    prompts: 'v2024-11-05'
                },
                backwardCompatible: ['2024-10-07', '2024-09-24']
            },
            '2024-10-07': {
                features: {
                    tools: true,
                    resources: true,
                    prompts: true,
                    sampling: true,
                    roots: true,
                    notifications: true,
                    progress: false,
                    cancellation: false
                },
                messageFormats: {
                    initialize: 'v2024-10-07',
                    tools: 'v2024-10-07',
                    resources: 'v2024-10-07',
                    prompts: 'v2024-10-07'
                },
                backwardCompatible: ['2024-09-24']
            },
            '2024-09-24': {
                features: {
                    tools: true,
                    resources: true,
                    prompts: false,
                    sampling: false,
                    roots: true,
                    notifications: false,
                    progress: false,
                    cancellation: false
                },
                messageFormats: {
                    initialize: 'v2024-09-24',
                    tools: 'v2024-09-24',
                    resources: 'v2024-09-24',
                    prompts: null
                },
                backwardCompatible: []
            }
        };
        
        // Version-specific message transformers
        this.messageTransformers = new Map();
        this._initializeMessageTransformers();
        
        // Deprecation warnings
        this.deprecatedVersions = new Set(['2024-09-24']);
        this.warningsShown = new Set();
    }
    
    /**
     * Get list of supported MCP protocol versions
     * @returns {string[]} Array of supported version strings
     */
    getSupportedVersions() {
        return [...this.supportedVersions];
    }
    
    /**
     * Negotiate the best compatible version with a server
     * @param {string[]} serverVersions - Versions supported by the server
     * @returns {Object} Negotiation result with version and capabilities
     */
    negotiateVersion(serverVersions) {
        if (!Array.isArray(serverVersions) || serverVersions.length === 0) {
            throw new Error('Server must provide at least one supported version');
        }
        
        // Find the best mutual version (prefer newer versions)
        let negotiatedVersion = null;
        let serverPreferredVersion = null;
        
        // Try to find exact matches, starting with our preferred versions
        for (const ourVersion of this.supportedVersions) {
            if (serverVersions.includes(ourVersion)) {
                negotiatedVersion = ourVersion;
                break;
            }
        }
        
        // If no exact match, try backward compatibility
        if (!negotiatedVersion) {
            for (const ourVersion of this.supportedVersions) {
                const compatibility = this.compatibilityMatrix[ourVersion];
                if (compatibility && compatibility.backwardCompatible) {
                    for (const serverVersion of serverVersions) {
                        if (compatibility.backwardCompatible.includes(serverVersion)) {
                            negotiatedVersion = ourVersion;
                            serverPreferredVersion = serverVersion;
                            break;
                        }
                    }
                    if (negotiatedVersion) break;
                }
            }
        }
        
        if (!negotiatedVersion) {
            const supportedStr = this.supportedVersions.join(', ');
            const serverStr = serverVersions.join(', ');
            throw new Error(
                `No compatible protocol version found. ` +
                `Client supports: [${supportedStr}], Server supports: [${serverStr}]`
            );
        }
        
        const capabilities = this.getVersionCapabilities(negotiatedVersion);
        const isDeprecated = this.deprecatedVersions.has(negotiatedVersion);
        
        // Show deprecation warning if needed
        if (isDeprecated && !this.warningsShown.has(negotiatedVersion)) {
            this.warningsShown.add(negotiatedVersion);
            this.emit('deprecationWarning', {
                version: negotiatedVersion,
                message: `Protocol version ${negotiatedVersion} is deprecated and may be removed in future versions`
            });
        }
        
        const result = {
            version: negotiatedVersion,
            serverPreferredVersion: serverPreferredVersion,
            capabilities: capabilities,
            isBackwardCompatible: !!serverPreferredVersion,
            isDeprecated: isDeprecated,
            negotiationDetails: {
                clientVersions: this.supportedVersions,
                serverVersions: serverVersions,
                selectedVersion: negotiatedVersion
            }
        };
        
        this.emit('versionNegotiated', result);
        return result;
    }
    
    /**
     * Check if a specific version is supported
     * @param {string} version - Version string to check
     * @returns {boolean} True if version is supported
     */
    isVersionSupported(version) {
        return this.supportedVersions.includes(version);
    }
    
    /**
     * Get feature capabilities for a specific version
     * @param {string} version - Protocol version
     * @returns {Object} Feature capabilities object
     */
    getVersionCapabilities(version) {
        const compatibility = this.compatibilityMatrix[version];
        if (!compatibility) {
            throw new Error(`Unknown protocol version: ${version}`);
        }
        
        return {
            ...compatibility.features,
            version: version,
            messageFormats: { ...compatibility.messageFormats }
        };
    }
    
    /**
     * Validate a message format for a specific version
     * @param {Object} message - Message to validate
     * @param {string} version - Protocol version
     * @returns {Object} Validation result
     */
    validateMessage(message, version) {
        const capabilities = this.getVersionCapabilities(version);
        const validation = {
            valid: true,
            errors: [],
            warnings: []
        };
        
        // Basic JSON-RPC validation
        if (!message.jsonrpc || message.jsonrpc !== '2.0') {
            validation.valid = false;
            validation.errors.push('Message must use JSON-RPC 2.0');
        }
        
        if (!message.method && message.id === undefined) {
            validation.valid = false;
            validation.errors.push('Message must have either method (notification/request) or id (response)');
        }
        
        // Version-specific validation
        if (message.method) {
            const methodParts = message.method.split('/');
            const category = methodParts[0];
            
            // Check if the method category is supported in this version
            switch (category) {
                case 'tools':
                    if (!capabilities.tools) {
                        validation.valid = false;
                        validation.errors.push(`Tools are not supported in protocol version ${version}`);
                    }
                    break;
                case 'resources':
                    if (!capabilities.resources) {
                        validation.valid = false;
                        validation.errors.push(`Resources are not supported in protocol version ${version}`);
                    }
                    break;
                case 'prompts':
                    if (!capabilities.prompts) {
                        validation.valid = false;
                        validation.errors.push(`Prompts are not supported in protocol version ${version}`);
                    }
                    break;
                case 'sampling':
                    if (!capabilities.sampling) {
                        validation.valid = false;
                        validation.errors.push(`Sampling is not supported in protocol version ${version}`);
                    }
                    break;
                case 'notifications':
                    if (!capabilities.notifications && message.method.startsWith('notifications/')) {
                        validation.warnings.push(`Notifications may not be fully supported in protocol version ${version}`);
                    }
                    break;
            }
        }
        
        // Check for version-specific parameters
        if (message.method === 'initialize' && message.params) {
            if (message.params.protocolVersion !== version) {
                validation.warnings.push(`Protocol version mismatch: message declares ${message.params.protocolVersion}, expected ${version}`);
            }
            
            // Check capabilities
            if (message.params.capabilities) {
                const caps = message.params.capabilities;
                
                if (caps.progress && !capabilities.progress) {
                    validation.warnings.push(`Progress capability not supported in version ${version}`);
                }
                
                if (caps.cancellation && !capabilities.cancellation) {
                    validation.warnings.push(`Cancellation capability not supported in version ${version}`);
                }
            }
        }
        
        return validation;
    }
    
    /**
     * Convert message format between versions
     * @param {Object} message - Message to convert
     * @param {string} fromVersion - Source version
     * @param {string} toVersion - Target version
     * @returns {Object} Converted message
     */
    upgradeMessage(message, fromVersion, toVersion) {
        if (fromVersion === toVersion) {
            return { ...message };
        }
        
        const transformer = this.messageTransformers.get(`${fromVersion}->${toVersion}`);
        if (transformer) {
            return transformer(message);
        }
        
        // Try to find a transformation path
        const path = this._findTransformationPath(fromVersion, toVersion);
        if (path.length === 0) {
            throw new Error(`No transformation path found from version ${fromVersion} to ${toVersion}`);
        }
        
        let transformedMessage = { ...message };
        for (let i = 0; i < path.length - 1; i++) {
            const stepTransformer = this.messageTransformers.get(`${path[i]}->${path[i + 1]}`);
            if (stepTransformer) {
                transformedMessage = stepTransformer(transformedMessage);
            }
        }
        
        return transformedMessage;
    }
    
    /**
     * Get version comparison result
     * @param {string} version1 - First version
     * @param {string} version2 - Second version
     * @returns {number} -1 if version1 < version2, 0 if equal, 1 if version1 > version2
     */
    compareVersions(version1, version2) {
        if (version1 === version2) return 0;
        
        const index1 = this.supportedVersions.indexOf(version1);
        const index2 = this.supportedVersions.indexOf(version2);
        
        // If both versions are in our supported list, compare by index (lower index = newer)
        if (index1 !== -1 && index2 !== -1) {
            return index1 < index2 ? 1 : -1;
        }
        
        // Fallback to string comparison for unknown versions
        return version1.localeCompare(version2);
    }
    
    /**
     * Check if version is deprecated
     * @param {string} version - Version to check
     * @returns {boolean} True if deprecated
     */
    isVersionDeprecated(version) {
        return this.deprecatedVersions.has(version);
    }
    
    /**
     * Get version information including features and compatibility
     * @param {string} version - Version to get info for
     * @returns {Object} Version information
     */
    getVersionInfo(version) {
        if (!this.isVersionSupported(version)) {
            throw new Error(`Unsupported version: ${version}`);
        }
        
        const compatibility = this.compatibilityMatrix[version];
        return {
            version: version,
            isSupported: true,
            isDeprecated: this.isVersionDeprecated(version),
            isCurrent: version === this.currentVersion,
            features: { ...compatibility.features },
            messageFormats: { ...compatibility.messageFormats },
            backwardCompatible: [...(compatibility.backwardCompatible || [])],
            releaseDate: this._getVersionReleaseDate(version)
        };
    }
    
    /**
     * Create initialization parameters for a specific version
     * @param {string} version - Protocol version
     * @param {Object} clientInfo - Client information
     * @returns {Object} Initialization parameters
     */
    createInitializeParams(version, clientInfo = {}) {
        const capabilities = this.getVersionCapabilities(version);
        
        const params = {
            protocolVersion: version,
            capabilities: {},
            clientInfo: {
                name: clientInfo.name || 'VSWizard',
                version: clientInfo.version || '1.0.0',
                ...clientInfo
            }
        };
        
        // Add version-appropriate capabilities
        if (capabilities.roots) {
            params.capabilities.roots = {
                listChanged: true
            };
        }
        
        if (capabilities.sampling) {
            params.capabilities.sampling = {};
        }
        
        if (capabilities.progress) {
            params.capabilities.progress = true;
        }
        
        if (capabilities.cancellation) {
            params.capabilities.cancellation = true;
        }
        
        return params;
    }
    
    // Private methods
    
    /**
     * Initialize message transformers for version conversion
     * @private
     */
    _initializeMessageTransformers() {
        // 2024-09-24 -> 2024-10-07
        this.messageTransformers.set('2024-09-24->2024-10-07', (message) => {
            const transformed = { ...message };
            
            // Add notification support
            if (message.method === 'initialize' && message.params) {
                transformed.params = { ...message.params };
                if (!transformed.params.capabilities) {
                    transformed.params.capabilities = {};
                }
                transformed.params.capabilities.notifications = true;
            }
            
            return transformed;
        });
        
        // 2024-10-07 -> 2024-11-05
        this.messageTransformers.set('2024-10-07->2024-11-05', (message) => {
            const transformed = { ...message };
            
            // Add progress and cancellation support
            if (message.method === 'initialize' && message.params) {
                transformed.params = { ...message.params };
                if (!transformed.params.capabilities) {
                    transformed.params.capabilities = {};
                }
                transformed.params.capabilities.progress = true;
                transformed.params.capabilities.cancellation = true;
            }
            
            return transformed;
        });
        
        // Direct 2024-09-24 -> 2024-11-05
        this.messageTransformers.set('2024-09-24->2024-11-05', (message) => {
            let transformed = this.messageTransformers.get('2024-09-24->2024-10-07')(message);
            transformed = this.messageTransformers.get('2024-10-07->2024-11-05')(transformed);
            return transformed;
        });
        
        // Reverse transformers (downgrade)
        this.messageTransformers.set('2024-11-05->2024-10-07', (message) => {
            const transformed = { ...message };
            
            // Remove unsupported capabilities
            if (message.method === 'initialize' && message.params && message.params.capabilities) {
                transformed.params = { ...message.params };
                transformed.params.capabilities = { ...message.params.capabilities };
                delete transformed.params.capabilities.progress;
                delete transformed.params.capabilities.cancellation;
            }
            
            return transformed;
        });
        
        this.messageTransformers.set('2024-10-07->2024-09-24', (message) => {
            const transformed = { ...message };
            
            // Remove notification support
            if (message.method === 'initialize' && message.params && message.params.capabilities) {
                transformed.params = { ...message.params };
                transformed.params.capabilities = { ...message.params.capabilities };
                delete transformed.params.capabilities.notifications;
            }
            
            return transformed;
        });
    }
    
    /**
     * Find transformation path between versions
     * @private
     */
    _findTransformationPath(fromVersion, toVersion) {
        // Simple implementation - could be enhanced with graph algorithms
        const fromIndex = this.supportedVersions.indexOf(fromVersion);
        const toIndex = this.supportedVersions.indexOf(toVersion);
        
        if (fromIndex === -1 || toIndex === -1) {
            return [];
        }
        
        const path = [];
        if (fromIndex < toIndex) {
            // Upgrading (newer to older in our array)
            for (let i = fromIndex; i <= toIndex; i++) {
                path.push(this.supportedVersions[i]);
            }
        } else {
            // Downgrading (older to newer in our array)
            for (let i = fromIndex; i >= toIndex; i--) {
                path.push(this.supportedVersions[i]);
            }
        }
        
        return path;
    }
    
    /**
     * Get release date for a version (mock implementation)
     * @private
     */
    _getVersionReleaseDate(version) {
        const releaseDates = {
            '2024-11-05': '2024-11-05',
            '2024-10-07': '2024-10-07',
            '2024-09-24': '2024-09-24'
        };
        
        return releaseDates[version] || 'Unknown';
    }
}

module.exports = MCPVersionManager;