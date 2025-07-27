const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * MCPSecurityValidator - Security validation for MCP server installations
 * Provides security checks for remote code execution and package integrity
 */
class MCPSecurityValidator {
    constructor(options = {}) {
        this.config = {
            enableCodeScanning: true,
            enableIntegrityChecks: true,
            enableSourceValidation: true,
            maxFileSize: 50 * 1024 * 1024, // 50MB
            allowedDomains: [
                'github.com',
                'gitlab.com',
                'bitbucket.org',
                'npmjs.org',
                'pypi.org'
            ],
            blockedPatterns: [
                /eval\s*\(/gi,
                /exec\s*\(/gi,
                /spawn\s*\(/gi,
                /child_process/gi,
                /fs\.unlink/gi,
                /rm\s+-rf/gi,
                /sudo\s+/gi,
                /chmod\s+777/gi,
                /\/etc\/passwd/gi,
                /\/etc\/shadow/gi
            ],
            trustedPublishers: [
                'modelcontextprotocol',
                'upstash',
                'anthropic'
            ],
            ...options
        };
        
        this.scanResults = new Map();
    }
    
    /**
     * Validate URL source security
     * @param {Object} urlInfo - Parsed URL information
     * @returns {Promise<Object>} Validation result
     */
    async validateSource(urlInfo) {
        const result = {
            valid: true,
            warnings: [],
            errors: [],
            riskLevel: 'low',
            checks: {
                domainValidation: false,
                publisherTrust: false,
                urlSafety: false
            }
        };
        
        // Domain validation
        if (this.config.enableSourceValidation) {
            const domainCheck = this._validateDomain(urlInfo);
            result.checks.domainValidation = domainCheck.valid;
            
            if (!domainCheck.valid) {
                result.errors.push(`Untrusted domain: ${domainCheck.domain}`);
                result.riskLevel = 'high';
                result.valid = false;
            }
        }
        
        // Publisher trust validation
        if (urlInfo.type === 'github' || urlInfo.type === 'gitlab') {
            const publisherCheck = this._validatePublisher(urlInfo);
            result.checks.publisherTrust = publisherCheck.trusted;
            
            if (!publisherCheck.trusted) {
                result.warnings.push(`Unknown publisher: ${publisherCheck.publisher}`);
                result.riskLevel = result.riskLevel === 'high' ? 'high' : 'medium';
            }
        }
        
        // URL safety checks
        const urlSafetyCheck = this._validateUrlSafety(urlInfo);
        result.checks.urlSafety = urlSafetyCheck.safe;
        
        if (!urlSafetyCheck.safe) {
            result.errors.push(...urlSafetyCheck.issues);
            result.riskLevel = 'high';
            result.valid = false;
        }
        
        return result;
    }
    
    /**
     * Scan source code for security issues
     * @param {string} sourceDir - Source directory to scan
     * @returns {Promise<Object>} Scan result
     */
    async scanSourceCode(sourceDir) {
        if (!this.config.enableCodeScanning) {
            return { scanned: false, issues: [] };
        }
        
        const scanId = crypto.randomUUID();
        const result = {
            scanId,
            scanned: true,
            issues: [],
            riskLevel: 'low',
            filesScanned: 0,
            suspiciousFiles: []
        };
        
        try {
            await this._scanDirectory(sourceDir, result);
            
            // Determine overall risk level
            if (result.issues.length > 0) {
                const highRiskIssues = result.issues.filter(issue => issue.severity === 'high');
                const mediumRiskIssues = result.issues.filter(issue => issue.severity === 'medium');
                
                if (highRiskIssues.length > 0) {
                    result.riskLevel = 'high';
                } else if (mediumRiskIssues.length > 2) {
                    result.riskLevel = 'high';
                } else if (mediumRiskIssues.length > 0) {
                    result.riskLevel = 'medium';
                }
            }
            
            // Cache scan results
            this.scanResults.set(scanId, result);
            
        } catch (error) {
            result.issues.push({
                type: 'scan_error',
                severity: 'medium',
                message: `Scan failed: ${error.message}`,
                file: sourceDir
            });
        }
        
        return result;
    }
    
    /**
     * Validate package integrity
     * @param {string} sourceDir - Source directory
     * @param {Object} packageInfo - Package information
     * @returns {Promise<Object>} Integrity check result
     */
    async validateIntegrity(sourceDir, packageInfo) {
        if (!this.config.enableIntegrityChecks) {
            return { validated: false, issues: [] };
        }
        
        const result = {
            validated: true,
            issues: [],
            checksums: {},
            packageSize: 0
        };
        
        try {
            // Calculate directory size
            result.packageSize = await this._calculateDirectorySize(sourceDir);
            
            // Check size limits
            if (result.packageSize > this.config.maxFileSize) {
                result.issues.push({
                    type: 'size_limit',
                    severity: 'medium',
                    message: `Package size (${Math.round(result.packageSize / 1024 / 1024)}MB) exceeds limit`,
                    limit: Math.round(this.config.maxFileSize / 1024 / 1024)
                });
            }
            
            // Validate package.json if present
            const packageJsonPath = path.join(sourceDir, 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const packageValidation = await this._validatePackageJson(packageJsonPath, packageInfo);
                result.issues.push(...packageValidation.issues);
            }
            
            // Generate checksums for important files
            const importantFiles = ['package.json', 'index.js', 'server.js', 'main.js'];
            for (const file of importantFiles) {
                const filePath = path.join(sourceDir, file);
                if (fs.existsSync(filePath)) {
                    result.checksums[file] = await this._calculateFileChecksum(filePath);
                }
            }
            
        } catch (error) {
            result.issues.push({
                type: 'integrity_error',
                severity: 'medium',
                message: `Integrity check failed: ${error.message}`
            });
        }
        
        return result;
    }
    
    /**
     * Get comprehensive security report
     * @param {string} scanId - Scan ID
     * @returns {Object} Security report
     */
    getSecurityReport(scanId) {
        const scanResult = this.scanResults.get(scanId);
        if (!scanResult) {
            return null;
        }
        
        return {
            scanId,
            timestamp: new Date().toISOString(),
            riskLevel: scanResult.riskLevel,
            summary: {
                filesScanned: scanResult.filesScanned,
                issuesFound: scanResult.issues.length,
                suspiciousFiles: scanResult.suspiciousFiles.length
            },
            issues: scanResult.issues,
            recommendations: this._generateRecommendations(scanResult)
        };
    }
    
    // Private methods
    
    /**
     * Validate domain safety
     * @private
     */
    _validateDomain(urlInfo) {
        let domain = '';
        
        if (urlInfo.cloneUrl) {
            const match = urlInfo.cloneUrl.match(/https?:\/\/([^\/]+)/);
            domain = match ? match[1] : '';
        } else if (urlInfo.registryUrl) {
            const match = urlInfo.registryUrl.match(/https?:\/\/([^\/]+)/);
            domain = match ? match[1] : '';
        }
        
        const isAllowed = this.config.allowedDomains.some(allowed => 
            domain.includes(allowed)
        );
        
        return {
            valid: isAllowed,
            domain
        };
    }
    
    /**
     * Validate publisher trust
     * @private
     */
    _validatePublisher(urlInfo) {
        const publisher = urlInfo.owner || '';
        const trusted = this.config.trustedPublishers.includes(publisher.toLowerCase());
        
        return {
            trusted,
            publisher
        };
    }
    
    /**
     * Validate URL safety
     * @private
     */
    _validateUrlSafety(urlInfo) {
        const issues = [];
        
        // Check for suspicious URL patterns
        const url = urlInfo.cloneUrl || urlInfo.fullName || '';
        
        if (url.includes('..')) {
            issues.push('URL contains directory traversal patterns');
        }
        
        if (url.match(/[<>"|]/)) {
            issues.push('URL contains potentially dangerous characters');
        }
        
        if (url.length > 500) {
            issues.push('URL is suspiciously long');
        }
        
        return {
            safe: issues.length === 0,
            issues
        };
    }
    
    /**
     * Scan directory recursively
     * @private
     */
    async _scanDirectory(dirPath, result) {
        const items = fs.readdirSync(dirPath);
        
        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory()) {
                // Skip node_modules and other common directories
                if (!['node_modules', '.git', '.vscode', 'dist', 'build'].includes(item)) {
                    await this._scanDirectory(itemPath, result);
                }
            } else if (stat.isFile()) {
                await this._scanFile(itemPath, result);
            }
        }
    }
    
    /**
     * Scan individual file
     * @private
     */
    async _scanFile(filePath, result) {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const scannableExtensions = ['.js', '.ts', '.py', '.sh', '.bash', '.json', '.yaml', '.yml'];
            
            if (!scannableExtensions.includes(ext)) {
                return;
            }
            
            result.filesScanned++;
            
            const content = fs.readFileSync(filePath, 'utf8');
            const issues = [];
            
            // Check for blocked patterns
            for (const pattern of this.config.blockedPatterns) {
                const matches = content.match(pattern);
                if (matches) {
                    issues.push({
                        type: 'suspicious_code',
                        severity: 'high',
                        message: `Suspicious pattern found: ${pattern.source}`,
                        file: filePath,
                        matches: matches.slice(0, 3) // Limit to first 3 matches
                    });
                }
            }
            
            // Check for obfuscated code
            if (this._isObfuscated(content)) {
                issues.push({
                    type: 'obfuscated_code',
                    severity: 'medium',
                    message: 'File appears to contain obfuscated code',
                    file: filePath
                });
            }
            
            // Check for excessive permissions
            if (content.includes('chmod 777') || content.includes('chmod +x')) {
                issues.push({
                    type: 'permission_change',
                    severity: 'medium',
                    message: 'File modifies permissions',
                    file: filePath
                });
            }
            
            if (issues.length > 0) {
                result.suspiciousFiles.push(filePath);
                result.issues.push(...issues);
            }
            
        } catch (error) {
            // Skip files that can't be read
        }
    }
    
    /**
     * Check if code appears obfuscated
     * @private
     */
    _isObfuscated(content) {
        // Simple heuristics for obfuscation detection
        const lines = content.split('\n');
        let suspiciousLines = 0;
        
        for (const line of lines.slice(0, 50)) { // Check first 50 lines
            const trimmed = line.trim();
            
            // Very long lines with no spaces
            if (trimmed.length > 200 && trimmed.split(' ').length < 5) {
                suspiciousLines++;
            }
            
            // High ratio of special characters
            const specialChars = (trimmed.match(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g) || []).length;
            if (specialChars > trimmed.length * 0.3) {
                suspiciousLines++;
            }
        }
        
        return suspiciousLines > 3;
    }
    
    /**
     * Calculate directory size
     * @private
     */
    async _calculateDirectorySize(dirPath) {
        let totalSize = 0;
        
        const items = fs.readdirSync(dirPath);
        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stat = fs.statSync(itemPath);
            
            if (stat.isDirectory()) {
                totalSize += await this._calculateDirectorySize(itemPath);
            } else {
                totalSize += stat.size;
            }
        }
        
        return totalSize;
    }
    
    /**
     * Validate package.json
     * @private
     */
    async _validatePackageJson(packageJsonPath, expectedInfo) {
        const issues = [];
        
        try {
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            
            // Check for suspicious scripts
            if (packageJson.scripts) {
                for (const [scriptName, scriptContent] of Object.entries(packageJson.scripts)) {
                    if (typeof scriptContent === 'string') {
                        for (const pattern of this.config.blockedPatterns) {
                            if (pattern.test(scriptContent)) {
                                issues.push({
                                    type: 'suspicious_script',
                                    severity: 'high',
                                    message: `Suspicious script "${scriptName}": ${scriptContent}`,
                                    script: scriptName
                                });
                            }
                        }
                    }
                }
            }
            
            // Check for suspicious dependencies
            const allDeps = {
                ...packageJson.dependencies,
                ...packageJson.devDependencies
            };
            
            for (const [depName, depVersion] of Object.entries(allDeps)) {
                if (depName.includes('..') || depName.includes('/')) {
                    issues.push({
                        type: 'suspicious_dependency',
                        severity: 'medium',
                        message: `Suspicious dependency name: ${depName}`,
                        dependency: depName
                    });
                }
            }
            
        } catch (error) {
            issues.push({
                type: 'package_parse_error',
                severity: 'low',
                message: `Failed to parse package.json: ${error.message}`
            });
        }
        
        return { issues };
    }
    
    /**
     * Calculate file checksum
     * @private
     */
    async _calculateFileChecksum(filePath) {
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    
    /**
     * Generate security recommendations
     * @private
     */
    _generateRecommendations(scanResult) {
        const recommendations = [];
        
        if (scanResult.riskLevel === 'high') {
            recommendations.push('⚠️  High risk detected - Review all issues before proceeding');
            recommendations.push('🔍 Manually inspect suspicious files');
            recommendations.push('🚫 Consider blocking this installation');
        } else if (scanResult.riskLevel === 'medium') {
            recommendations.push('⚡ Medium risk detected - Proceed with caution');
            recommendations.push('👀 Review flagged issues');
            recommendations.push('🔒 Run in isolated environment');
        } else {
            recommendations.push('✅ Low risk detected - Safe to proceed');
            recommendations.push('📝 Monitor for unusual behavior');
        }
        
        if (scanResult.suspiciousFiles.length > 0) {
            recommendations.push(`🔎 Review ${scanResult.suspiciousFiles.length} suspicious files`);
        }
        
        return recommendations;
    }
}

module.exports = MCPSecurityValidator;