const { spawn, exec } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const MCPSecurityValidator = require('./MCPSecurityValidator');

/**
 * MCPEnhancedInstaller - Advanced MCP server installation system
 * Features automatic build detection, dependency resolution, caching, and security validation
 */
class MCPEnhancedInstaller extends EventEmitter {
    /**
     * Initialize the enhanced installer
     * @param {Object} outputChannel - VSCode output channel for logging
     * @param {Object} options - Configuration options
     */
    constructor(outputChannel = null, options = {}) {
        super();
        
        this.outputChannel = outputChannel;
        this.isWindows = os.platform() === 'win32';
        this.installationDir = path.join(os.homedir(), '.vscode', 'mcp-servers');
        this.cacheDir = path.join(this.installationDir, '.cache');
        this.buildCacheDir = path.join(this.cacheDir, 'builds');
        this.metadataDir = path.join(this.cacheDir, 'metadata');
        
        // Configuration
        this.config = {
            maxConcurrentBuilds: 3,
            buildTimeout: 600000, // 10 minutes
            cacheExpiry: 7 * 24 * 60 * 60 * 1000, // 7 days
            securityChecks: true,
            autoRetry: true,
            maxRetries: 3,
            ...options
        };
        
        // Build queue management
        this.buildQueue = [];
        this.activeBuildCount = 0;
        this.buildCache = new Map();
        
        // URL parsing patterns
        this.urlPatterns = {
            github: /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)(?:\/tree\/([^\/]+))?(?:\/(.*))?$/,
            gitlab: /^https?:\/\/gitlab\.com\/([^\/]+)\/([^\/]+)(?:\/-\/tree\/([^\/]+))?(?:\/(.*))?$/,
            bitbucket: /^https?:\/\/bitbucket\.org\/([^\/]+)\/([^\/]+)(?:\/src\/([^\/]+))?(?:\/(.*))?$/,
            npm: /^(?:npm:)?(@?[a-z0-9-_]+(?:\/[a-z0-9-_]+)?)(?:@([^@]+))?$/,
            pip: /^(?:pip:|pypi:)?([a-z0-9-_]+)(?:==([^=]+))?$/,
            git: /^git\+https?:\/\/.*\.git$/,
            tarball: /^https?:\/\/.*\.(tar\.gz|tgz|zip)$/,
            local: /^file:\/\/(.+)$/
        };
        
        // Build system detection patterns
        this.buildSystems = {
            typescript: {
                files: ['tsconfig.json'],
                commands: ['npm run build', 'yarn build', 'tsc', 'bun run build'],
                outputDirs: ['dist', 'build', 'lib', 'out']
            },
            webpack: {
                files: ['webpack.config.js', 'webpack.config.ts'],
                commands: ['npm run build', 'yarn build', 'webpack', 'bun run build'],
                outputDirs: ['dist', 'build']
            },
            rollup: {
                files: ['rollup.config.js', 'rollup.config.ts'],
                commands: ['npm run build', 'yarn build', 'rollup -c', 'bun run build'],
                outputDirs: ['dist', 'build']
            },
            vite: {
                files: ['vite.config.js', 'vite.config.ts'],
                commands: ['npm run build', 'yarn build', 'vite build', 'bun run build'],
                outputDirs: ['dist', 'build']
            },
            esbuild: {
                files: ['esbuild.config.js', 'build.js'],
                commands: ['npm run build', 'yarn build', 'esbuild', 'bun run build'],
                outputDirs: ['dist', 'build']
            },
            python: {
                files: ['setup.py', 'pyproject.toml', 'setup.cfg'],
                commands: ['pip install -e .', 'python setup.py install', 'poetry install'],
                outputDirs: ['build', 'dist']
            },
            rust: {
                files: ['Cargo.toml'],
                commands: ['cargo build --release'],
                outputDirs: ['target/release']
            },
            go: {
                files: ['go.mod'],
                commands: ['go build', 'go install'],
                outputDirs: ['bin']
            }
        };
        
        // Initialize security validator
        this.securityValidator = new MCPSecurityValidator({
            enableCodeScanning: this.config.securityChecks,
            enableIntegrityChecks: this.config.securityChecks,
            enableSourceValidation: this.config.securityChecks
        });
        
        // Initialize directories
        this._ensureDirectories();
        
        // Load build cache
        this._loadBuildCache();
    }
    
    /**
     * Enhanced URL parsing with support for multiple source types
     * @param {string} url - URL or package identifier
     * @returns {Object} Parsed URL information
     */
    parseUrl(url) {
        const trimmedUrl = url.trim();
        
        // GitHub repository
        const githubMatch = trimmedUrl.match(this.urlPatterns.github);
        if (githubMatch) {
            return {
                type: 'github',
                owner: githubMatch[1],
                repo: githubMatch[2],
                branch: githubMatch[3] || 'main',
                path: githubMatch[4] || '',
                cloneUrl: `https://github.com/${githubMatch[1]}/${githubMatch[2]}.git`,
                apiUrl: `https://api.github.com/repos/${githubMatch[1]}/${githubMatch[2]}`,
                packageName: githubMatch[2],
                fullName: `${githubMatch[1]}/${githubMatch[2]}`
            };
        }
        
        // GitLab repository
        const gitlabMatch = trimmedUrl.match(this.urlPatterns.gitlab);
        if (gitlabMatch) {
            return {
                type: 'gitlab',
                owner: gitlabMatch[1],
                repo: gitlabMatch[2],
                branch: gitlabMatch[3] || 'main',
                path: gitlabMatch[4] || '',
                cloneUrl: `https://gitlab.com/${gitlabMatch[1]}/${gitlabMatch[2]}.git`,
                apiUrl: `https://gitlab.com/api/v4/projects/${encodeURIComponent(gitlabMatch[1] + '/' + gitlabMatch[2])}`,
                packageName: gitlabMatch[2],
                fullName: `${gitlabMatch[1]}/${gitlabMatch[2]}`
            };
        }
        
        // NPM package
        const npmMatch = trimmedUrl.match(this.urlPatterns.npm);
        if (npmMatch) {
            return {
                type: 'npm',
                packageName: npmMatch[1],
                version: npmMatch[2] || 'latest',
                registryUrl: `https://registry.npmjs.org/${npmMatch[1]}`,
                fullName: npmMatch[1]
            };
        }
        
        // Python package
        const pipMatch = trimmedUrl.match(this.urlPatterns.pip);
        if (pipMatch) {
            return {
                type: 'pip',
                packageName: pipMatch[1],
                version: pipMatch[2] || 'latest',
                registryUrl: `https://pypi.org/pypi/${pipMatch[1]}/json`,
                fullName: pipMatch[1]
            };
        }
        
        // Git repository (generic)
        if (this.urlPatterns.git.test(trimmedUrl)) {
            return {
                type: 'git',
                cloneUrl: trimmedUrl,
                packageName: this._extractRepoName(trimmedUrl),
                fullName: trimmedUrl
            };
        }
        
        // Tarball/Archive
        if (this.urlPatterns.tarball.test(trimmedUrl)) {
            return {
                type: 'tarball',
                downloadUrl: trimmedUrl,
                packageName: this._extractArchiveName(trimmedUrl),
                fullName: trimmedUrl
            };
        }
        
        // Local file
        const localMatch = trimmedUrl.match(this.urlPatterns.local);
        if (localMatch) {
            return {
                type: 'local',
                path: localMatch[1],
                packageName: path.basename(localMatch[1]),
                fullName: localMatch[1]
            };
        }
        
        // Default to npm for simple package names
        return {
            type: 'npm',
            packageName: trimmedUrl,
            version: 'latest',
            registryUrl: `https://registry.npmjs.org/${trimmedUrl}`,
            fullName: trimmedUrl
        };
    }
    
    /**
     * Detect installation method from URL or package name (legacy compatibility)
     * @param {string} url - URL or package identifier
     * @returns {Object} Installation method details
     */
    detectInstallMethod(url) {
        const urlInfo = this.parseUrl(url);
        
        // Convert enhanced URL info to legacy format for compatibility
        return {
            method: urlInfo.type === 'github' || urlInfo.type === 'gitlab' || urlInfo.type === 'git' ? 'git' : urlInfo.type,
            url: urlInfo.cloneUrl || urlInfo.downloadUrl || urlInfo.registryUrl || url,
            packageName: urlInfo.packageName
        };
    }
    
    /**
     * Validate system dependencies
     * @param {string} method - Installation method (npm, pip, git)
     * @returns {Promise<boolean>} True if dependencies are available
     */
    async validateDependencies(method) {
        const commands = {
            npm: 'npm',
            pip: 'pip',
            git: 'git'
        };
        
        const command = commands[method];
        if (!command) {
            throw new Error(`Unknown installation method: ${method}`);
        }
        
        try {
            await this._runCommand(command, ['--version'], { timeout: 5000 });
            return true;
        } catch (error) {
            throw new Error(`${command} is not installed or not available in PATH`);
        }
    }
    
    /**
     * Install NPM package (legacy compatibility method)
     * @param {string} packageName - NPM package name
     * @param {Object} [options] - Installation options
     * @returns {Promise<Object>} Installation result
     */
    async installNpmPackage(packageName, options = {}) {
        // Use the enhanced installer with npm: prefix
        const npmUrl = `npm:${packageName}${options.version ? `@${options.version}` : ''}`;
        return this.installServer(npmUrl, options);
    }
    
    /**
     * Install Python package (legacy compatibility method)
     * @param {string} packageName - Python package name
     * @param {Object} [options] - Installation options
     * @returns {Promise<Object>} Installation result
     */
    async installPipPackage(packageName, options = {}) {
        // Use the enhanced installer with pip: prefix
        const pipUrl = `pip:${packageName}${options.version ? `==${options.version}` : ''}`;
        return this.installServer(pipUrl, options);
    }
    
    /**
     * Install from Git repository (legacy compatibility method)
     * @param {string} repoUrl - Git repository URL
     * @param {Object} [options] - Installation options
     * @returns {Promise<Object>} Installation result
     */
    async installGitRepository(repoUrl, options = {}) {
        // Use the enhanced installer directly
        return this.installServer(repoUrl, options);
    }
    
    /**
     * Install server with enhanced capabilities
     * @param {string} url - Installation URL or package name
     * @param {Object} options - Installation options
     * @returns {Promise<Object>} Installation result
     */
    async installServer(url, options = {}) {
        const installId = crypto.randomUUID();
        const startTime = Date.now();
        
        try {
            this._log(`[${installId}] Starting enhanced installation from: ${url}`);
            this.emit('installStarted', { installId, url, options });
            
            // Parse URL
            const urlInfo = this.parseUrl(url);
            this._log(`[${installId}] Detected source type: ${urlInfo.type}`);
            
            // Check cache first
            const cacheKey = this._generateCacheKey(urlInfo, options);
            const cachedResult = await this._checkCache(cacheKey);
            if (cachedResult && !options.forceReinstall) {
                this._log(`[${installId}] Using cached installation`);
                this.emit('installCompleted', { ...cachedResult, fromCache: true });
                return cachedResult;
            }
            
            // Security validation
            if (this.config.securityChecks) {
                await this._validateSecurity(urlInfo, options);
            }
            
            // Download/clone source
            const sourceDir = await this._acquireSource(urlInfo, installId, options);
            
            // Detect project type and build system
            const projectInfo = await this._analyzeProject(sourceDir);
            this._log(`[${installId}] Detected project type: ${projectInfo.type}, build system: ${projectInfo.buildSystem}`);
            
            // Install dependencies
            await this._installDependencies(sourceDir, projectInfo, installId, options);
            
            // Build project if needed
            const buildResult = await this._buildProject(sourceDir, projectInfo, installId, options);
            
            // Validate build output
            await this._validateBuild(sourceDir, buildResult, projectInfo);
            
            // Security validation of built code
            const securityResult = await this._validateBuildSecurity(sourceDir, projectInfo);
            
            // Create server configuration
            const serverConfig = await this._createServerConfig(sourceDir, projectInfo, buildResult, urlInfo, installId);
            serverConfig.securityResult = securityResult;
            
            // Cache the result
            await this._cacheResult(cacheKey, serverConfig, sourceDir);
            
            const duration = Date.now() - startTime;
            this._log(`[${installId}] Installation completed successfully in ${duration}ms`);
            this.emit('installCompleted', { ...serverConfig, installId, duration });
            
            return serverConfig;
            
        } catch (error) {
            const duration = Date.now() - startTime;
            this._log(`[${installId}] Installation failed after ${duration}ms: ${error.message}`, 'error');
            this.emit('installFailed', { installId, url, error, duration });
            
            // Retry logic
            if (this.config.autoRetry && options.retryCount < this.config.maxRetries) {
                this._log(`[${installId}] Retrying installation (${options.retryCount + 1}/${this.config.maxRetries})`);
                return this.installServer(url, { ...options, retryCount: (options.retryCount || 0) + 1 });
            }
            
            throw error;
        }
    }
    
    /**
     * Acquire source code from various sources
     * @private
     */
    async _acquireSource(urlInfo, installId, options) {
        const sourceDir = path.join(this.installationDir, urlInfo.type, urlInfo.packageName);
        
        // Remove existing directory if it exists
        if (fs.existsSync(sourceDir)) {
            await this._removeDirectory(sourceDir);
        }
        
        await this._ensureDirectory(sourceDir);
        
        switch (urlInfo.type) {
            case 'github':
            case 'gitlab':
            case 'git':
                await this._cloneRepository(urlInfo, sourceDir, installId, options);
                break;
                
            case 'npm':
                await this._downloadNpmPackage(urlInfo, sourceDir, installId, options);
                break;
                
            case 'pip':
                await this._downloadPipPackage(urlInfo, sourceDir, installId, options);
                break;
                
            case 'tarball':
                await this._downloadTarball(urlInfo, sourceDir, installId, options);
                break;
                
            case 'local':
                await this._copyLocalSource(urlInfo, sourceDir, installId, options);
                break;
                
            default:
                throw new Error(`Unsupported source type: ${urlInfo.type}`);
        }
        
        return sourceDir;
    }
    
    /**
     * Clone Git repository with enhanced features
     * @private
     */
    async _cloneRepository(urlInfo, sourceDir, installId, options) {
        this._log(`[${installId}] Cloning repository: ${urlInfo.cloneUrl}`);
        
        const cloneArgs = ['clone'];
        
        // Add branch/tag if specified
        if (urlInfo.branch && urlInfo.branch !== 'main' && urlInfo.branch !== 'master') {
            cloneArgs.push('--branch', urlInfo.branch);
        }
        
        // Shallow clone for faster downloads
        if (!options.fullHistory) {
            cloneArgs.push('--depth', '1');
        }
        
        cloneArgs.push(urlInfo.cloneUrl, sourceDir);
        
        await this._runCommand('git', cloneArgs, {
            onProgress: (data) => {
                this.emit('installProgress', { installId, stage: 'clone', data });
                if (options.onProgress) options.onProgress(data);
            }
        });
        
        // Checkout specific path if needed
        if (urlInfo.path) {
            const fullPath = path.join(sourceDir, urlInfo.path);
            if (fs.existsSync(fullPath)) {
                // Move contents of subdirectory to root
                const tempDir = path.join(sourceDir, '..', 'temp-' + installId);
                await this._moveDirectory(fullPath, tempDir);
                await this._removeDirectory(sourceDir);
                await this._moveDirectory(tempDir, sourceDir);
            }
        }
    }
    
    /**
     * Download NPM package source
     * @private
     */
    async _downloadNpmPackage(urlInfo, sourceDir, installId, options) {
        this._log(`[${installId}] Downloading NPM package: ${urlInfo.packageName}@${urlInfo.version}`);
        
        // Use npm pack to get the source
        const packArgs = ['pack', `${urlInfo.packageName}@${urlInfo.version}`, '--pack-destination', sourceDir];
        
        await this._runCommand('npm', packArgs, {
            onProgress: (data) => {
                this.emit('installProgress', { installId, stage: 'download', data });
                if (options.onProgress) options.onProgress(data);
            }
        });
        
        // Extract the tarball
        const tarballFiles = fs.readdirSync(sourceDir).filter(f => f.endsWith('.tgz'));
        if (tarballFiles.length > 0) {
            const tarballPath = path.join(sourceDir, tarballFiles[0]);
            await this._extractTarball(tarballPath, sourceDir);
            fs.unlinkSync(tarballPath);
            
            // Move package contents to root
            const packageDir = path.join(sourceDir, 'package');
            if (fs.existsSync(packageDir)) {
                const tempDir = path.join(sourceDir, '..', 'temp-' + installId);
                await this._moveDirectory(packageDir, tempDir);
                await this._removeDirectory(sourceDir);
                await this._moveDirectory(tempDir, sourceDir);
            }
        }
    }
    
    /**
     * Analyze project to detect type and build system
     * @private
     */
    async _analyzeProject(sourceDir) {
        const projectInfo = {
            type: 'unknown',
            buildSystem: 'none',
            packageManager: 'npm',
            hasPackageJson: false,
            hasRequirements: false,
            buildFiles: [],
            entryPoints: [],
            dependencies: {},
            scripts: {}
        };
        
        // Check for package.json (Node.js)
        const packageJsonPath = path.join(sourceDir, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            projectInfo.hasPackageJson = true;
            projectInfo.type = 'nodejs';
            
            try {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                projectInfo.dependencies = {
                    ...packageJson.dependencies,
                    ...packageJson.devDependencies
                };
                projectInfo.scripts = packageJson.scripts || {};
                
                // Detect package manager
                if (fs.existsSync(path.join(sourceDir, 'yarn.lock'))) {
                    projectInfo.packageManager = 'yarn';
                } else if (fs.existsSync(path.join(sourceDir, 'pnpm-lock.yaml'))) {
                    projectInfo.packageManager = 'pnpm';
                } else if (fs.existsSync(path.join(sourceDir, 'bun.lockb'))) {
                    projectInfo.packageManager = 'bun';
                }
            } catch (error) {
                this._log(`Failed to parse package.json: ${error.message}`, 'warn');
            }
        }
        
        // Check for Python files
        const requirementsPath = path.join(sourceDir, 'requirements.txt');
        const setupPyPath = path.join(sourceDir, 'setup.py');
        const pyprojectPath = path.join(sourceDir, 'pyproject.toml');
        
        if (fs.existsSync(requirementsPath) || fs.existsSync(setupPyPath) || fs.existsSync(pyprojectPath)) {
            projectInfo.hasRequirements = true;
            if (projectInfo.type === 'unknown') {
                projectInfo.type = 'python';
            }
        }
        
        // Detect build system
        for (const [buildSystem, config] of Object.entries(this.buildSystems)) {
            for (const file of config.files) {
                if (fs.existsSync(path.join(sourceDir, file))) {
                    projectInfo.buildSystem = buildSystem;
                    projectInfo.buildFiles.push(file);
                    break;
                }
            }
            if (projectInfo.buildSystem !== 'none') break;
        }
        
        // Find entry points
        const commonEntryPoints = [
            'index.js', 'index.ts', 'server.js', 'server.ts', 'main.js', 'main.ts',
            'app.js', 'app.ts', 'src/index.js', 'src/index.ts', 'src/server.js', 'src/server.ts',
            'dist/index.js', 'build/index.js', 'lib/index.js'
        ];
        
        for (const entry of commonEntryPoints) {
            if (fs.existsSync(path.join(sourceDir, entry))) {
                projectInfo.entryPoints.push(entry);
            }
        }
        
        return projectInfo;
    }
    
    /**
     * Install project dependencies
     * @private
     */
    async _installDependencies(sourceDir, projectInfo, installId, options) {
        this._log(`[${installId}] Installing dependencies`);
        
        if (projectInfo.hasPackageJson) {
            const installCmd = this._getPackageManagerInstallCommand(projectInfo.packageManager);
            
            await this._runCommand(installCmd.command, installCmd.args, {
                cwd: sourceDir,
                onProgress: (data) => {
                    this.emit('installProgress', { installId, stage: 'dependencies', data });
                    if (options.onProgress) options.onProgress(data);
                }
            });
        }
        
        if (projectInfo.hasRequirements) {
            // Install Python dependencies
            const pythonCommands = [
                { command: 'pip', args: ['install', '-r', 'requirements.txt'] },
                { command: 'pip', args: ['install', '-e', '.'] }
            ];
            
            for (const cmd of pythonCommands) {
                const reqFile = cmd.args.includes('requirements.txt') ? 
                    path.join(sourceDir, 'requirements.txt') : 
                    path.join(sourceDir, 'setup.py');
                    
                if (fs.existsSync(reqFile)) {
                    try {
                        await this._runCommand(cmd.command, cmd.args, {
                            cwd: sourceDir,
                            onProgress: (data) => {
                                this.emit('installProgress', { installId, stage: 'dependencies', data });
                                if (options.onProgress) options.onProgress(data);
                            }
                        });
                    } catch (error) {
                        this._log(`Python dependency installation failed: ${error.message}`, 'warn');
                    }
                }
            }
        }
    }
    
    /**
     * Build project if build system is detected
     * @private
     */
    async _buildProject(sourceDir, projectInfo, installId, options) {
        if (projectInfo.buildSystem === 'none') {
            this._log(`[${installId}] No build system detected, skipping build`);
            return { built: false, outputDir: sourceDir };
        }
        
        this._log(`[${installId}] Building project with ${projectInfo.buildSystem}`);
        
        const buildConfig = this.buildSystems[projectInfo.buildSystem];
        let buildSuccess = false;
        let outputDir = sourceDir;
        
        // Try build commands in order
        for (const command of buildConfig.commands) {
            try {
                const [cmd, ...args] = command.split(' ');
                
                await this._runCommand(cmd, args, {
                    cwd: sourceDir,
                    timeout: this.config.buildTimeout,
                    onProgress: (data) => {
                        this.emit('installProgress', { installId, stage: 'build', data });
                        if (options.onProgress) options.onProgress(data);
                    }
                });
                
                buildSuccess = true;
                break;
                
            } catch (error) {
                this._log(`Build command '${command}' failed: ${error.message}`, 'warn');
                continue;
            }
        }
        
        if (!buildSuccess) {
            throw new Error(`All build commands failed for ${projectInfo.buildSystem}`);
        }
        
        // Find output directory
        for (const dir of buildConfig.outputDirs) {
            const fullPath = path.join(sourceDir, dir);
            if (fs.existsSync(fullPath)) {
                outputDir = fullPath;
                break;
            }
        }
        
        return { built: true, outputDir, buildSystem: projectInfo.buildSystem };
    }
    
    /**
     * Validate build output
     * @private
     */
    async _validateBuild(sourceDir, buildResult, projectInfo) {
        if (!buildResult.built) {
            return true; // No build to validate
        }
        
        // Check if output directory exists and has files
        if (!fs.existsSync(buildResult.outputDir)) {
            throw new Error(`Build output directory not found: ${buildResult.outputDir}`);
        }
        
        const outputFiles = fs.readdirSync(buildResult.outputDir);
        if (outputFiles.length === 0) {
            throw new Error(`Build output directory is empty: ${buildResult.outputDir}`);
        }
        
        // Look for expected entry points
        const expectedEntries = ['index.js', 'main.js', 'server.js', 'app.js'];
        const hasEntryPoint = expectedEntries.some(entry => 
            fs.existsSync(path.join(buildResult.outputDir, entry))
        );
        
        if (!hasEntryPoint && projectInfo.type === 'nodejs') {
            this._log(`Warning: No standard entry point found in build output`, 'warn');
        }
        
        return true;
    }
    
    /**
     * Create server configuration
     * @private
     */
    async _createServerConfig(sourceDir, projectInfo, buildResult, urlInfo, installId) {
        const serverConfig = {
            id: `enhanced-${urlInfo.type}-${urlInfo.packageName}`,
            name: urlInfo.packageName,
            description: `MCP Server from ${urlInfo.fullName}`,
            version: urlInfo.version || 'latest',
            installMethod: 'enhanced',
            installUrl: urlInfo.fullName,
            installPath: sourceDir,
            buildResult,
            projectInfo,
            metadata: {
                installId,
                installedAt: new Date().toISOString(),
                sourceType: urlInfo.type,
                buildSystem: projectInfo.buildSystem,
                packageManager: projectInfo.packageManager
            }
        };
        
        // Determine command to run the server
        const command = this._determineServerCommand(sourceDir, projectInfo, buildResult, urlInfo);
        serverConfig.command = command.command;
        serverConfig.args = command.args;
        serverConfig.cwd = command.cwd;
        serverConfig.env = command.env;
        
        return serverConfig;
    }
    
    /**
     * Determine the command to run the MCP server
     * @private
     */
    _determineServerCommand(sourceDir, projectInfo, buildResult, urlInfo) {
        // For built projects, use the build output
        if (buildResult.built) {
            const outputDir = buildResult.outputDir;
            
            // Look for entry points in build output
            const entryPoints = ['index.js', 'main.js', 'server.js', 'app.js'];
            for (const entry of entryPoints) {
                const entryPath = path.join(outputDir, entry);
                if (fs.existsSync(entryPath)) {
                    return {
                        command: 'node',
                        args: [path.relative(sourceDir, entryPath)],
                        cwd: sourceDir,
                        env: {}
                    };
                }
            }
        }
        
        // For NPM packages with bin entries
        if (projectInfo.hasPackageJson) {
            const packageJsonPath = path.join(sourceDir, 'package.json');
            try {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                
                // Check for bin entries
                if (packageJson.bin) {
                    const binName = typeof packageJson.bin === 'string' 
                        ? packageJson.name 
                        : Object.keys(packageJson.bin)[0];
                    
                    if (binName) {
                        return {
                            command: 'npx',
                            args: [binName],
                            cwd: sourceDir,
                            env: {}
                        };
                    }
                }
                
                // Check for start script
                if (packageJson.scripts && packageJson.scripts.start) {
                    return {
                        command: 'npm',
                        args: ['start'],
                        cwd: sourceDir,
                        env: {}
                    };
                }
            } catch (error) {
                this._log(`Failed to parse package.json for command determination: ${error.message}`, 'warn');
            }
        }
        
        // For scoped NPM packages, use npx
        if (urlInfo.type === 'npm' && urlInfo.packageName.startsWith('@')) {
            return {
                command: 'npx',
                args: ['-y', urlInfo.packageName],
                cwd: process.cwd(),
                env: {}
            };
        }
        
        // Look for common entry points
        for (const entry of projectInfo.entryPoints) {
            const entryPath = path.join(sourceDir, entry);
            if (fs.existsSync(entryPath)) {
                const isTypeScript = entry.endsWith('.ts');
                return {
                    command: isTypeScript ? 'ts-node' : 'node',
                    args: [entry],
                    cwd: sourceDir,
                    env: {}
                };
            }
        }
        
        // Default fallback
        return {
            command: 'node',
            args: ['index.js'],
            cwd: sourceDir,
            env: {}
        };
    }
    
    /**
     * Security validation for remote sources
     * @private
     */
    async _validateSecurity(urlInfo, options) {
        if (!this.config.securityChecks) {
            return { valid: true, warnings: [], errors: [] };
        }
        
        this._log(`Running security validation for ${urlInfo.type}:${urlInfo.fullName}`);
        
        // Validate source URL
        const sourceValidation = await this.securityValidator.validateSource(urlInfo);
        
        if (!sourceValidation.valid) {
            const errorMsg = `Security validation failed: ${sourceValidation.errors.join(', ')}`;
            this._log(errorMsg, 'error');
            throw new Error(errorMsg);
        }
        
        if (sourceValidation.warnings.length > 0) {
            this._log(`Security warnings: ${sourceValidation.warnings.join(', ')}`, 'warn');
        }
        
        this._log(`Security validation passed (Risk level: ${sourceValidation.riskLevel})`);
        return sourceValidation;
    }
    
    /**
     * Validate build output and source code security
     * @private
     */
    async _validateBuildSecurity(sourceDir, projectInfo) {
        if (!this.config.securityChecks) {
            return { scanned: false, issues: [] };
        }
        
        this._log(`Scanning source code for security issues`);
        
        // Scan source code
        const scanResult = await this.securityValidator.scanSourceCode(sourceDir);
        
        // Validate package integrity
        const integrityResult = await this.securityValidator.validateIntegrity(sourceDir, projectInfo);
        
        // Combine results
        const combinedResult = {
            scanned: scanResult.scanned,
            validated: integrityResult.validated,
            riskLevel: scanResult.riskLevel,
            issues: [...scanResult.issues, ...integrityResult.issues],
            filesScanned: scanResult.filesScanned,
            packageSize: integrityResult.packageSize,
            checksums: integrityResult.checksums
        };
        
        // Log results
        if (combinedResult.issues.length > 0) {
            const highRiskIssues = combinedResult.issues.filter(issue => issue.severity === 'high');
            if (highRiskIssues.length > 0) {
                this._log(`High risk security issues found: ${highRiskIssues.length}`, 'error');
                for (const issue of highRiskIssues.slice(0, 3)) {
                    this._log(`  - ${issue.message}`, 'error');
                }
                
                if (!this.config.allowHighRisk) {
                    throw new Error(`Installation blocked due to high risk security issues`);
                }
            }
            
            this._log(`Security scan completed: ${combinedResult.issues.length} issues found (Risk: ${combinedResult.riskLevel})`, 'warn');
        } else {
            this._log(`Security scan completed: No issues found`);
        }
        
        return combinedResult;
    }
    
    /**
     * Cache management
     * @private
     */
    async _checkCache(cacheKey) {
        const cacheFile = path.join(this.metadataDir, `${cacheKey}.json`);
        
        if (!fs.existsSync(cacheFile)) {
            return null;
        }
        
        try {
            const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            
            // Check if cache is expired
            if (Date.now() - cacheData.timestamp > this.config.cacheExpiry) {
                fs.unlinkSync(cacheFile);
                return null;
            }
            
            // Check if cached files still exist
            if (!fs.existsSync(cacheData.installPath)) {
                fs.unlinkSync(cacheFile);
                return null;
            }
            
            return cacheData.serverConfig;
            
        } catch (error) {
            this._log(`Cache read error: ${error.message}`, 'warn');
            return null;
        }
    }
    
    /**
     * Cache installation result
     * @private
     */
    async _cacheResult(cacheKey, serverConfig, sourceDir) {
        const cacheFile = path.join(this.metadataDir, `${cacheKey}.json`);
        
        const cacheData = {
            timestamp: Date.now(),
            cacheKey,
            serverConfig,
            installPath: sourceDir
        };
        
        try {
            fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2));
        } catch (error) {
            this._log(`Cache write error: ${error.message}`, 'warn');
        }
    }
    
    /**
     * Generate cache key for installation
     * @private
     */
    _generateCacheKey(urlInfo, options) {
        const keyData = {
            type: urlInfo.type,
            fullName: urlInfo.fullName,
            version: urlInfo.version,
            options: {
                version: options.version,
                branch: options.branch
            }
        };
        
        return crypto.createHash('sha256')
            .update(JSON.stringify(keyData))
            .digest('hex')
            .substring(0, 16);
    }
    
    /**
     * Get package manager install command
     * @private
     */
    _getPackageManagerInstallCommand(packageManager) {
        const commands = {
            npm: { command: 'npm', args: ['install'] },
            yarn: { command: 'yarn', args: ['install'] },
            pnpm: { command: 'pnpm', args: ['install'] },
            bun: { command: 'bun', args: ['install'] }
        };
        
        return commands[packageManager] || commands.npm;
    }
    
    /**
     * Download Python package (placeholder)
     * @private
     */
    async _downloadPipPackage(urlInfo, sourceDir, installId, options) {
        // For now, use pip to download source
        this._log(`[${installId}] Downloading Python package: ${urlInfo.packageName}`);
        
        await this._runCommand('pip', ['download', '--no-deps', '--src', sourceDir, urlInfo.packageName], {
            onProgress: (data) => {
                this.emit('installProgress', { installId, stage: 'download', data });
                if (options.onProgress) options.onProgress(data);
            }
        });
    }
    
    /**
     * Download and extract tarball
     * @private
     */
    async _downloadTarball(urlInfo, sourceDir, installId, options) {
        this._log(`[${installId}] Downloading tarball: ${urlInfo.downloadUrl}`);
        
        // Use curl or wget to download
        const filename = path.basename(urlInfo.downloadUrl);
        const tarballPath = path.join(sourceDir, filename);
        
        await this._runCommand('curl', ['-L', '-o', tarballPath, urlInfo.downloadUrl], {
            onProgress: (data) => {
                this.emit('installProgress', { installId, stage: 'download', data });
                if (options.onProgress) options.onProgress(data);
            }
        });
        
        // Extract tarball
        await this._extractTarball(tarballPath, sourceDir);
        fs.unlinkSync(tarballPath);
    }
    
    /**
     * Copy local source
     * @private
     */
    async _copyLocalSource(urlInfo, sourceDir, installId, options) {
        this._log(`[${installId}] Copying local source: ${urlInfo.path}`);
        
        if (!fs.existsSync(urlInfo.path)) {
            throw new Error(`Local path does not exist: ${urlInfo.path}`);
        }
        
        // Copy directory recursively
        await this._copyDirectory(urlInfo.path, sourceDir);
    }
    
    /**
     * Extract tarball
     * @private
     */
    async _extractTarball(tarballPath, extractDir) {
        const isZip = tarballPath.endsWith('.zip');
        
        if (isZip) {
            await this._runCommand('unzip', ['-q', tarballPath, '-d', extractDir]);
        } else {
            await this._runCommand('tar', ['-xzf', tarballPath, '-C', extractDir, '--strip-components=1']);
        }
    }
    
    /**
     * Extract repository name from URL
     * @private
     */
    _extractRepoName(url) {
        const match = url.match(/\/([^\/]+?)(?:\.git)?(?:\/)?$/);
        return match ? match[1] : 'unknown-repo';
    }
    
    /**
     * Extract archive name from URL
     * @private
     */
    _extractArchiveName(url) {
        const filename = path.basename(url);
        return filename.replace(/\.(tar\.gz|tgz|zip)$/, '');
    }
    
    /**
     * Ensure directories exist
     * @private
     */
    _ensureDirectories() {
        const dirs = [
            this.installationDir,
            this.cacheDir,
            this.buildCacheDir,
            this.metadataDir
        ];
        
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }
    
    /**
     * Load build cache from disk
     * @private
     */
    _loadBuildCache() {
        // Load cached build information
        this.buildCache.clear();
        
        try {
            const cacheFiles = fs.readdirSync(this.metadataDir);
            for (const file of cacheFiles) {
                if (file.endsWith('.json')) {
                    const cacheKey = file.replace('.json', '');
                    this.buildCache.set(cacheKey, true);
                }
            }
        } catch (error) {
            // Cache directory doesn't exist yet
        }
    }
    
    /**
     * Ensure directory exists
     * @private
     */
    async _ensureDirectory(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
    
    /**
     * Remove directory recursively
     * @private
     */
    async _removeDirectory(dirPath) {
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
        }
    }
    
    /**
     * Move directory
     * @private
     */
    async _moveDirectory(srcPath, destPath) {
        if (fs.existsSync(srcPath)) {
            await this._copyDirectory(srcPath, destPath);
            await this._removeDirectory(srcPath);
        }
    }
    
    /**
     * Copy directory recursively
     * @private
     */
    async _copyDirectory(srcPath, destPath) {
        await this._ensureDirectory(destPath);
        
        const items = fs.readdirSync(srcPath);
        for (const item of items) {
            const srcItem = path.join(srcPath, item);
            const destItem = path.join(destPath, item);
            
            const stat = fs.statSync(srcItem);
            if (stat.isDirectory()) {
                await this._copyDirectory(srcItem, destItem);
            } else {
                fs.copyFileSync(srcItem, destItem);
            }
        }
    }
    
    /**
     * Run command with enhanced error handling
     * @private
     */
    async _runCommand(command, args, options = {}) {
        return new Promise((resolve, reject) => {
            const { cwd, onProgress, timeout = 300000 } = options;
            
            this._log(`Running: ${command} ${args.join(' ')}`);
            
            const child = spawn(command, args, {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: this.isWindows
            });
            
            let stdout = '';
            let stderr = '';
            
            child.stdout.on('data', (data) => {
                const text = data.toString();
                stdout += text;
                this._log(text.trim());
                if (onProgress) onProgress({ type: 'stdout', data: text });
            });
            
            child.stderr.on('data', (data) => {
                const text = data.toString();
                stderr += text;
                this._log(text.trim(), 'warn');
                if (onProgress) onProgress({ type: 'stderr', data: text });
            });
            
            child.on('close', (code) => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                } else {
                    reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
                }
            });
            
            child.on('error', (error) => {
                reject(new Error(`Command error: ${error.message}`));
            });
            
            // Set timeout
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`Command timeout after ${timeout}ms`));
            }, timeout);
            
            child.on('close', () => clearTimeout(timer));
        });
    }
    
    /**
     * Log message to output channel
     * @private
     */
    _log(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [MCPEnhancedInstaller] [${level.toUpperCase()}] ${message}`;
        
        if (this.outputChannel) {
            this.outputChannel.appendLine(logMessage);
        } else {
            console.log(logMessage);
        }
        
        this.emit('log', { message, level, timestamp });
    }
    
    /**
     * Uninstall server with enhanced cleanup
     * @param {Object} serverConfig - Server configuration
     * @returns {Promise<boolean>} True if uninstalled successfully
     */
    async uninstallServer(serverConfig) {
        try {
            this._log(`Uninstalling enhanced server: ${serverConfig.id}`);
            this.emit('uninstallStarted', serverConfig);
            
            // Remove installation directory
            if (serverConfig.installPath && fs.existsSync(serverConfig.installPath)) {
                await this._removeDirectory(serverConfig.installPath);
            }
            
            // Remove cache entries
            if (serverConfig.metadata && serverConfig.metadata.installId) {
                const cachePattern = `*${serverConfig.metadata.installId}*`;
                const cacheFiles = fs.readdirSync(this.metadataDir);
                
                for (const file of cacheFiles) {
                    if (file.includes(serverConfig.metadata.installId)) {
                        const cacheFile = path.join(this.metadataDir, file);
                        fs.unlinkSync(cacheFile);
                    }
                }
            }
            
            this._log(`Enhanced server uninstalled successfully: ${serverConfig.id}`);
            this.emit('uninstallCompleted', serverConfig);
            
            return true;
            
        } catch (error) {
            this._log(`Enhanced uninstall failed: ${error.message}`, 'error');
            this.emit('uninstallFailed', { serverConfig, error });
            throw error;
        }
    }
    
    /**
     * Update server from source
     * @param {Object} serverConfig - Server configuration
     * @param {Object} options - Update options
     * @returns {Promise<Object>} Updated server configuration
     */
    async updateServer(serverConfig, options = {}) {
        this._log(`Updating server: ${serverConfig.id}`);
        
        // Force reinstall with same URL
        const updateOptions = {
            ...options,
            forceReinstall: true,
            retryCount: 0
        };
        
        return this.installServer(serverConfig.installUrl, updateOptions);
    }
    
    /**
     * Get installation status
     * @param {string} installId - Installation ID
     * @returns {Object} Installation status
     */
    getInstallationStatus(installId) {
        return {
            installId,
            active: this.activeBuildCount > 0,
            queueLength: this.buildQueue.length,
            cached: this.buildCache.has(installId)
        };
    }
    
    /**
     * Clear cache
     * @param {Object} options - Clear options
     * @returns {Promise<boolean>} True if cleared successfully
     */
    async clearCache(options = {}) {
        try {
            this._log('Clearing installation cache');
            
            if (options.all || options.metadata) {
                // Clear metadata cache
                if (fs.existsSync(this.metadataDir)) {
                    const files = fs.readdirSync(this.metadataDir);
                    for (const file of files) {
                        fs.unlinkSync(path.join(this.metadataDir, file));
                    }
                }
            }
            
            if (options.all || options.builds) {
                // Clear build cache
                if (fs.existsSync(this.buildCacheDir)) {
                    await this._removeDirectory(this.buildCacheDir);
                    await this._ensureDirectory(this.buildCacheDir);
                }
            }
            
            // Reload cache
            this._loadBuildCache();
            
            this._log('Cache cleared successfully');
            return true;
            
        } catch (error) {
            this._log(`Cache clear failed: ${error.message}`, 'error');
            throw error;
        }
    }
    
    /**
     * Get NPM package information (legacy compatibility)
     * @private
     */
    async _getPackageInfo(packageName, installDir, isGlobal) {
        try {
            if (isGlobal) {
                const result = await this._runCommand('npm', ['list', '-g', '--json', packageName]);
                const data = JSON.parse(result.stdout);
                return data.dependencies?.[packageName] || {};
            } else {
                const packageJsonPath = path.join(installDir, 'node_modules', packageName, 'package.json');
                if (fs.existsSync(packageJsonPath)) {
                    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                }
            }
        } catch (error) {
            this._log(`Failed to get package info: ${error.message}`, 'warn');
        }
        return {};
    }
    
    /**
     * Get pip package information (legacy compatibility)
     * @private
     */
    async _getPipPackageInfo(packageName) {
        try {
            const result = await this._runCommand('pip', ['show', packageName]);
            const info = {};
            result.stdout.split('\n').forEach(line => {
                const [key, ...valueParts] = line.split(':');
                if (key && valueParts.length > 0) {
                    info[key.toLowerCase().trim()] = valueParts.join(':').trim();
                }
            });
            return info;
        } catch (error) {
            this._log(`Failed to get pip package info: ${error.message}`, 'warn');
            return {};
        }
    }
    
    /**
     * Get package information from npm registry (legacy compatibility)
     * @private
     */
    async _getPackageInfoFromRegistry(packageName) {
        try {
            const result = await this._runCommand('npm', ['view', packageName, '--json'], {
                timeout: 10000
            });
            return JSON.parse(result.stdout);
        } catch (error) {
            this._log(`Failed to get package info from registry: ${error.message}`, 'warn');
            return { name: packageName };
        }
    }
    
    /**
     * Determine NPM command to run (legacy compatibility)
     * @private
     */
    _determineNpmCommand(packageName, packageInfo, isGlobal) {
        // Check for bin entries in package.json
        if (packageInfo.bin) {
            const binName = typeof packageInfo.bin === 'string'
                ? packageName
                : Object.keys(packageInfo.bin)[0];
            
            return {
                command: isGlobal ? binName : 'npx',
                args: isGlobal ? [] : [binName],
                cwd: isGlobal ? undefined : path.join(this.installationDir, 'npm', packageName),
                env: {}
            };
        }
        
        // Default to npx
        return {
            command: 'npx',
            args: [packageName],
            cwd: path.join(this.installationDir, 'npm', packageName),
            env: {}
        };
    }
    
    /**
     * Determine npx command to run for scoped packages (legacy compatibility)
     * @private
     */
    _determineNpxCommand(packageName, packageInfo) {
        // For scoped packages like @upstash/context7-mcp, use npx with -y flag
        return {
            command: 'npx',
            args: ['-y', packageName],
            cwd: process.cwd(), // Use current working directory
            env: {}
        };
    }
    
    /**
     * Determine pip command to run (legacy compatibility)
     * @private
     */
    _determinePipCommand(packageName, packageInfo) {
        // Try common patterns for Python MCP servers
        const possibleCommands = [
            packageName,
            `${packageName}-server`,
            `mcp-${packageName}`,
            'python',
            'python3'
        ];
        
        // Default to the package name
        return {
            command: possibleCommands[0],
            args: [],
            cwd: path.join(this.installationDir, 'pip', packageName),
            env: {}
        };
    }
    
    /**
     * Determine git repository command to run (legacy compatibility)
     * @private
     */
    _determineGitCommand(installDir, packageInfo, setupMethod) {
        if (setupMethod === 'npm' && packageInfo.bin) {
            const binName = typeof packageInfo.bin === 'string'
                ? Object.keys(packageInfo.bin)[0] || 'server'
                : Object.keys(packageInfo.bin)[0];
                
            return {
                command: 'npm',
                args: ['start'],
                cwd: installDir,
                env: {}
            };
        }
        
        if (setupMethod === 'python') {
            return {
                command: 'python',
                args: ['-m', path.basename(installDir)],
                cwd: installDir,
                env: {}
            };
        }
        
        // Look for common entry points
        const possibleEntries = ['server.js', 'index.js', 'main.py', 'server.py'];
        for (const entry of possibleEntries) {
            if (fs.existsSync(path.join(installDir, entry))) {
                const isNode = entry.endsWith('.js');
                return {
                    command: isNode ? 'node' : 'python',
                    args: [entry],
                    cwd: installDir,
                    env: {}
                };
            }
        }
        
        // Default fallback
        return {
            command: 'node',
            args: ['index.js'],
            cwd: installDir,
            env: {}
        };
    }
}

module.exports = MCPEnhancedInstaller;