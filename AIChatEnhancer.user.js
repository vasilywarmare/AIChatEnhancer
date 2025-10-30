// ==UserScript==
// @name         AI Chat Enhancer
// @namespace    https://github.com/vasilywarmare
// @version      0.9
// @description  Enhances AI chat platforms with message virtualisation, live counter, and export functionality
// @author       WarmarE
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://grok.com/*               
// @match        https://chat.deepseek.com/*      
// @match        https://claude.ai/*              
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/vasilywarmare/AIChatEnhancer
// @supportURL   https://github.com/vasilywarmare/AIChatEnhancer/issues
// @updateURL    https://raw.githubusercontent.com/vasilywarmare/AIChatEnhancer/main/AIChatEnhancer.user.js
// @downloadURL  https://raw.githubusercontent.com/vasilywarmare/AIChatEnhancer/main/AIChatEnhancer.user.js
// ==/UserScript==

"use strict";

// --------------------------------------------------------------------------------
// Section: Runtime State Settings
// --------------------------------------------------------------------------------

/// <summary>
/// Global application state containing configuration, UI references, and runtime state.
/// Centralised state management for the virtualiser, counter, and UI components.
/// </summary>
const State =
{
    // Character limit configuration
    maxChars: 150000,         // Hard stop (approximately where the AI chat platform disables the send button)
    cautionThreshold: 142500, // Early warning (turns gold when above this)
    
    // Platform detection cache (optimisation)
    currentPlatform: null,       // Cached platform detection result
    currentAdapter: null,        // Cached adapter reference  
    currentMessageSelectors: '', // Cached message selector string
    currentInputSelectors: '',   // Cached input selector string

    // UI element references
    panelElement: null,   // Root HUD container <div>
    counterElement: null, // Text span showing the character count
    
    // Runtime state
    virtualiserEnabled: true, // Whether virtualisation is currently active

    // Viewport buffer configuration for virtualiser
    visibilityBuffer:         
    {
        top: 0.5,   // Allow ~1 viewport height above screen to stay rendered
        bottom: 0.5 // Allow ~1 viewport height below screen to stay rendered
    },

    // Observer instances for DOM monitoring
    observers:
    {
        intersection: null, // IntersectionObserver for virtualisation
        mutation: null      // MutationObserver for SPA changes
    },

    // Timer handles for background operations
    timers:
    {
        counterHandler: null,           // Control handle for counter update interval
        legacyVirtualiserHandler: null, // Control handle for legacy virtualiser 
        counterRunning: false           // Whether the counter update loop is active
    },

    // Debug configuration
    debug:
    {
        hasLoggedVirtualise: false, // Whether to log IO virtualise events
        hasLoggedRestore: false,    // Whether to log IO restore events
        ioRestoreDelay: 0,          // Artificial delay before IO restores a message (0 = off)
        logIO: false,               // Log IO events to console when true
        benchmark: false,           // Log benchmark results to console when true
        
        stats:
        {
            virtualisedCount: 0, // Number of messages virtualised
            lastUpdateTime: 0    // Last update time
        }
    }
};

// --------------------------------------------------------------------------------
// Section: Constants & Configuration
// --------------------------------------------------------------------------------

/// <summary>
/// Default configuration values for the application.
/// </summary>
const DefaultConfig = 
{
    // Character limit configuration
    maxChars: 150000,         // Hard stop (approximately where the AI chat platform disables the send button)
    cautionThreshold: 142500, // Early warning (turns gold when above this)

    // Viewport buffer configuration for virtualiser
    visibilityBuffer:         
    {
        top: 0.5,             // Allow ~1 viewport height above screen to stay rendered
        bottom: 0.5           // Allow ~1 viewport height below screen to stay rendered
    },
};

/// <summary>
/// Conversion factor for bytes to megabytes (1024 * 1024).
/// </summary>
const BytesPerMegabyte = 1048576;

// --------------------------------------------------------------------------------
// Section: Platform Testing & Configuration
// --------------------------------------------------------------------------------

/// <summary>
/// Configuration for platform-specific testing and adaptation strategies.
/// Allows gradual rollout of platform support with testing flags.
/// </summary>
const PlatformConfig = 
{
    // Testing flags for gradual platform enablement
    testing: 
    {
        chatgpt: true,    // First: ChatGPT testing
        deepseek: true,   // Next: DeepSeek testing
        grok: true,       // Next: Grok testing  
        claude: true,     // Next: Claude testing
        gemini: true      // Next: Gemini testing
    },
    
    // Platform-specific adapter configurations
    adapters: 
    {
        chatgpt: 
        {
            selectors: 
            [
                "[data-message-author-role]",          // Primary: role identifier (highest priority)
                "[data-testid='conversation-turn']",   // Primary: conversation turn container  
                "div[data-testid='message-bubble']",   // Primary: message bubble container
                "[data-message-id]",                   // Fallback: message unique identifier
                "[data-testid='conversation-turn']"    // Fallback: duplicate for ensured matching
            ],

            inputSelectors: 
            [
                "[data-testid='prompt-textarea']",     // Primary: ChatGPT-specific input
                "textarea",                            // Secondary: generic textarea
                "[contenteditable='true']"             // Fallback: editable content area
            ]

            // No messageRole needed: uses standard element.getAttribute("data-message-author-role")
        },

        deepseek: 
        {
            selectors: 
            [
                ".ds-message",               // Primary: message containers (highest priority)
                ".ds-markdown",              // Primary: rendered message content
                "[class*='ds-message']",     // Fallback: ds-message-like classes
                "[class*='ds-markdown']",    // Fallback: ds-markdown-like classes
                "[data-role]"                // Universal: role attribute fallback
            ],

            inputSelectors: 
            [
                "[contenteditable='true']",  // Primary: modern editable divisions
                "textarea",                  // Secondary: traditional textareas
                "[class*='input']",          // Fallback: input-like classes
                "[class*='ds-input']",       // Platform-specific: DeepSeek inputs
                "form textarea"              // Universal: form textareas
            ],

            messageRole: (element) => 
            {
                const className = element.className || '';
                const parentClass = element.parentElement?.className || '';
        
                // DeepSeek's new pattern: d29f3d7d class = user messages
                if (className.includes('d29f3d7d') || parentClass.includes('d29f3d7d')) 
                {
                    return "user";
                }
                
                // Default to assistant if no specific class found
                return "assistant";
            }
        },

        grok: 
        {
            selectors: 
            [
                "[class*='message']",
                "[data-role]",
                ".message-container"
            ],

            inputSelectors: 
            [
                "[contenteditable='true']",
                "textarea"
            ]
        },

        claude: 
        {
            selectors: 
            [
                "[data-role]",
                ".message",
                "article"
            ],

            inputSelectors: 
            [
                "[contenteditable='true']",
                "form textarea"
            ]
        },

        gemini: 
        {
            selectors: 
            [
                ".message-item",
                "[role='listitem']",
                "div[role='article']"
            ],

            inputSelectors: 
            [
                "textarea",
                "[contenteditable='true']"
            ]
        }
    }
};

// --------------------------------------------------------------------------------
// Section: Utility Classes
// --------------------------------------------------------------------------------

/// <summary>
/// Custom error classes for better error handling and debugging.
/// </summary>
class ValidationError extends Error 
{
    constructor(message) 
    {
        super(message);
        this.name = 'ValidationError';
        this.code = 'VALIDATION_FAILED';
    }
}

class NetworkError extends Error 
{
    constructor(message) 
    {
        super(message);
        this.name = 'NetworkError';
        this.code = 'NETWORK_FAILED';
    }
}

class ConfigurationError extends Error 
{
    constructor(message) 
    {
        super(message);
        this.name = 'ConfigurationError';
        this.code = 'CONFIG_FAILED';
    }
}

/// <summary>
/// LRU (Least Recently Used) cache implementation for efficient memory management.
/// Automatically removes least recently used items when cache reaches maximum size.
/// </summary>
class LRUCache 
{
    constructor(maxSize = 100) 
    {
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    
    /// <summary>
    /// Retrieves a value from cache and updates its access order.
    /// </summary>
    Get(key) 
    {
        if (this.cache.has(key)) 
        {
            const value = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, value);
            
            return value;
        }

        return null;
    }
    
    /// <summary>
    /// Stores a value in cache, removing oldest item if cache is full.
    /// </summary>
    Set(key, value) 
    {
        if (this.cache.has(key)) 
        {
            this.cache.delete(key);
        } 
        else if (this.cache.size >= this.maxSize) 
        {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, value);
    }
    
    /// <summary>
    /// Removes a specific key from cache.
    /// </summary>
    Delete(key) { return this.cache.delete(key); }
    
    /// <summary>
    /// Clears all entries from cache.
    /// </summary>
    Clear() { this.cache.clear(); }
    
    /// <summary>
    /// Returns current cache size.
    /// </summary>
    get size() { return this.cache.size; }
    
    /// <summary>
    /// Checks if cache contains a specific key.
    /// </summary>
    Has(key) { return this.cache.has(key); }
}

/// <summary>
/// Performance benchmarking utilities for measuring execution time and performance metrics.
/// </summary>
class PerformanceBenchmark 
{
    static measurements = new Map();
    
    /// <summary>
    /// Measures synchronous function execution time.
    /// </summary>
    static Measure(name, action) 
    {
        const start = performance.now();
        const result = action();
        const end = performance.now();
        
        const duration = end - start;
        this.RecordMeasurement(name, duration);
        
        if (State.debug.benchmark) 
        {
            console.log(`[AIEnhancer] Benchmark ${name}: ${duration.toFixed(2)}ms`);
        }
        
        return result;
    }
    
    /// <summary>
    /// Measures asynchronous function execution time.
    /// </summary>
    static async MeasureAsync(name, task) 
    {
        const start = performance.now();
        const result = await task();
        const end = performance.now();
        
        const duration = end - start;
        this.RecordMeasurement(name, duration);
        
        if (State.debug.benchmark) 
        {
            console.log(`[AIEnhancer] Benchmark ${name}: ${duration.toFixed(2)}ms`);
        }
        
        return result;
    }
    
    /// <summary>
    /// Records measurement for statistical analysis.
    /// </summary>
    static RecordMeasurement(name, duration) 
    {
        if (!this.measurements.has(name)) 
        {
            this.measurements.set(name, []);
        }
        
        const measurements = this.measurements.get(name);
        measurements.push(duration);
        
        // Keep only last 100 measurements
        if (measurements.length > 100) 
        {
            measurements.shift();
        }
    }
    
    /// <summary>
    /// Gets performance statistics for a specific measurement.
    /// </summary>
    static GetStats(name) 
    {
        const measurements = this.measurements.get(name);
        
        if (!measurements || measurements.length === 0) return null;
        
        const sorted = [...measurements].sort((a, b) => a - b);
        const sum = measurements.reduce((a, b) => a + b, 0);
        const avg = sum / measurements.length;
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const median = sorted[Math.floor(sorted.length / 2)];

        const stats = 
        { 
            count: measurements.length,
            average: avg,
            min: min,
            max: max,
            median: median,
            latest: measurements[measurements.length - 1]
        };

        return stats;
    }
    
    /// <summary>
    /// Clears all performance measurements.
    /// </summary>
    static Clear() { this.measurements.clear(); }
}

// --------------------------------------------------------------------------------
// Section: Global Instances
// --------------------------------------------------------------------------------

/// <summary>
/// Keeps original live child nodes per message while virtualised.
/// Using WeakMap so GC can reclaim when the element goes away.
/// </summary>
const OriginalNodes = new WeakMap();

/// <summary>
/// WeakMap tracking ResizeObserver instances for each virtualised message element.
/// Ensures proper cleanup when messages are restored or removed from DOM.
/// </summary>
const PlaceholderResizeObservers = new WeakMap();

// Item limit configuration for LRU cache
const maxLRUItems = 200;

/// <summary>
/// LRU cache for storing original HTML content with automatic memory management.
/// </summary>
const OriginalHtml = new LRUCache(maxLRUItems);

// --------------------------------------------------------------------------------
// Section: Initialisation
// --------------------------------------------------------------------------------

/// <summary>
/// Initialises application state including validation and localStorage restoration.
/// </summary>
function InitialiseState(state) 
{
    // First validate the state configuration
    ValidateState(state);
    
    // Then restore virtualiser state from localStorage
    try 
    {
        const savedVirtualiserState = localStorage.getItem("ai_enhancer_virtualiser_on");
        
        if (savedVirtualiserState !== null) 
        {
            state.virtualiserEnabled = JSON.parse(savedVirtualiserState);
        }
    } 
    catch (error) 
    {
        if (state.debug.logIO) console.debug("[AIEnhancer] Failed to restore virtualiser state:", error);
    }
}

/// <summary>
/// Validates and corrects state configuration to ensure valid values.
/// Throws ConfigurationError for invalid configurations.
/// </summary>
function ValidateState(state) 
{
    try 
    {
        if (state.maxChars <= 0) 
        {
            throw new ConfigurationError("maxChars must be positive");
        }
        
        if (state.cautionThreshold >= state.maxChars) 
        {
            state.cautionThreshold = Math.floor(state.maxChars * 0.95);
        }
        
        if (state.visibilityBuffer.top < 0) 
        {
            throw new ConfigurationError("visibilityBuffer.top must be non-negative");
        }
        
        if (state.visibilityBuffer.bottom < 0) 
        {
            throw new ConfigurationError("visibilityBuffer.bottom must be non-negative");
        }
    } 
    catch (error) 
    {
        if (error instanceof ConfigurationError) 
        {
            console.error("[AIEnhancer] Config validation failed:", error.message);
            // Apply default values as fallback using Object.assign
            Object.assign(state, DefaultConfig);
        } 
        else 
        {
            throw error;
        }
    }
}

/// <summary>
/// Checks browser support for required APIs and logs warnings for unsupported features.
/// </summary>
function CheckBrowserSupport() 
{
    const support = 
    {
        intersectionObserver: 'IntersectionObserver' in window,
        resizeObserver: 'ResizeObserver' in window,
        requestIdleCallback: 'requestIdleCallback' in window
    };
    
    if (!support.intersectionObserver) 
    {
        console.warn("[AIEnhancer] IntersectionObserver not supported, using legacy mode");
    }
    
    if (!support.resizeObserver) 
    {
        console.warn("[AIEnhancer] ResizeObserver not supported, height sync may be limited");
    }
    
    if (!support.requestIdleCallback) 
    {
        console.warn("[AIEnhancer] requestIdleCallback not supported, using setTimeout fallback");
    }
    
    return support;
}

/// <summary>
/// Injects CSS styles into document head for HUD styling.
/// Only runs once to avoid duplicate style injection.
/// </summary>
function InjectHudStyles() 
{
    if (document.getElementById('aceHudStyles')) return;
    
    const style = document.createElement('style');
    style.id = 'aceHudStyles';

    style.textContent = 
    `
        .AceHudContainer 
        {
            position: fixed;
            right: 24px;
            bottom: 20px;
            font-size: 12px;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 6px;
            background: rgba(0,0,0,0.25);
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid var(--border, #444);
            min-width: 180px;
            backdrop-filter: blur(4px);
            user-select: none;
        }
        
        .AceButton 
        {
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 8px;
            border: 1px solid var(--border, #444);
            background: var(--bg, #222);
            color: inherit;
            cursor: pointer;
        }
        
        .AcePlaceholder 
        {
            text-align: center;
            opacity: 0.5;
            font-size: 12px;
        }
    `;
    
    document.head.appendChild(style);
}

/// <summary>
/// Initialises platform-specific features based on detection.
/// </summary>
function InitialisePlatformFeatures(state) 
{
    try 
    {
        if (!ShouldUsePlatformAware()) 
        {
            console.log("[AIEnhancer] Using legacy fallback mode");

            return;
        }
        
        EnsureIntersectionObserver(state);
        
        if (state.debug.logIO) 
        {
            console.log("[AIEnhancer] Using platform-aware functions for:", DetectPlatform());
        }
    } 
    catch (error) 
    { 
        console.warn("[AIEnhancer] Platform features disabled:", error.message); 
    }
}

/// <summary>
/// Initialises debugging and development tools.
/// </summary>
function InitialiseDebuggingTools(state) 
{
    EnsureMutationObserver(state);
    SetupGlobalDebug();
}

/// <summary>
/// Initialises platform detection and caches results in state for global use.
/// Should be called once during application startup.
/// </summary>
function InitialisePlatformDetection(state) 
{
    state.currentPlatform = DetectPlatform();
    console.log(`[AIEnhancer] Detected platform: ${state.currentPlatform}`);
    
    if (state.currentPlatform !== 'unknown') 
    {
        state.currentAdapter = PlatformConfig.adapters[state.currentPlatform];
        
        if (state.currentAdapter) 
        {
            state.currentMessageSelectors = state.currentAdapter.selectors.join(', ');
            state.currentInputSelectors = state.currentAdapter.inputSelectors.join(', ');
            
            console.log(`[AIEnhancer] Cached ${state.currentAdapter.selectors.length} message selectors`);
            console.log(`[AIEnhancer] Cached ${state.currentAdapter.inputSelectors.length} input selectors`);
        }
        else
        {
            console.warn(`[AIEnhancer] No adapter found for platform: ${state.currentPlatform}`);
        }
    }
    else
    {
        console.warn(`[AIEnhancer] Unknown platform: ${window.location.hostname}`);
    }
}

/// <summary>
/// Initialises core application components.
/// </summary>
function InitialiseCoreComponents(state) 
{
    InjectHudStyles();
    CreatePanel(state);
    BindGlobalEvents(state);
    StartLoops(state);
    UpdateCounter(state);
}

// --------------------------------------------------------------------------------
// Section: Core Virtualisation
// --------------------------------------------------------------------------------

/// <summary>
/// Virtualises a message element by moving its child nodes into storage
/// and replacing them with a height-preserving placeholder.
/// This preserves syntax highlight markup for later restoration.
/// </summary>
function VirtualiseMessage(element) 
{
    if (element.dataset.virtualised === "1") return;

    const nodes = Array.from(element.childNodes);
    OriginalNodes.set(element, nodes);

    const height = element.offsetHeight || 24;
    const placeholder = document.createElement("div");
    ApplyPlaceholderStyle(placeholder);
    placeholder.style.height = height + "px";

    element.dataset.virtualised = "1"; // Flag: 1 = on, 0 = off
    element.innerHTML = "";
    element.appendChild(placeholder);

    if (window.ResizeObserver && !PlaceholderResizeObservers.has(element))
    {
        const resizeObserver = new ResizeObserver(() =>
        {
            if (element.dataset.virtualised === "1")
            {
                const currentHeight = element.offsetHeight || 24;
                placeholder.style.height = currentHeight + "px";
            }
        });

        resizeObserver.observe(element);
        PlaceholderResizeObservers.set(element, resizeObserver);
    }
    
    const stats = State.debug.stats;
    stats.virtualisedCount = (stats.virtualisedCount || 0) + 1; // Increment virtualised count
    
    if (State.debug.logIO && !State.debug.hasLoggedVirtualise)
    {
        try { console.log("[AIEnhancer] Virtualise function activated", element); }
        catch (error) { console.debug("[AIEnhancer] Virtualise log failed:", error); }

        State.debug.hasLoggedVirtualise = true;
    }
}

/// <summary>
/// Restores all virtualised messages to their original HTML content.
/// Ensures all placeholders are replaced with original markup after restoration.
/// </summary>
function RestoreAllMessages() 
{
    const messages = SelectAllMessages();

    for (const msg of messages) 
    {
        if (msg.dataset.virtualised === "1")
        {
            RestoreMessage(msg);
        }
    }
}

/// <summary>
/// Restores a virtualised message element by re-attaching its original child nodes.
/// Cleans up observers and restores original markup.
/// </summary>
function RestoreMessage(element) 
{
    if (element.dataset.virtualised !== "1") return;

    const resizeObserver = PlaceholderResizeObservers.get(element);

    if (resizeObserver)
    {
        try 
        { 
            resizeObserver.disconnect(); 
        } 
        catch 
        {
            if (State.debug.logIO) 
            {
                console.debug("[AIEnhancer] ResizeObserver cleanup error:", error);
            }
        }

        PlaceholderResizeObservers.delete(element);
    }

    const nodes = OriginalNodes.get(element) || [];
    element.dataset.virtualised = "";
    element.innerHTML = "";

    for (const node of nodes)
    {
        element.appendChild(node);
    }

    OriginalNodes.delete(element);

    const stats = State.debug.stats;
    stats.virtualisedCount = Math.max(0, (stats.virtualisedCount || 0) - 1); // Decrement virtualised count

    if (State.debug.logIO && !State.debug.hasLoggedRestore)
    {
        try { console.log("[AIEnhancer] Restore function activated", element); }
        catch (error) { console.debug("[AIEnhancer] Restore log failed:", error); }

        State.debug.hasLoggedRestore = true;
    }
}

/// <summary>
/// Finds all message elements in the current conversation using multiple selector strategies.
/// Returns de-duplicated top-level message wrappers to avoid nested matches.
/// Logs matched selectors for debugging using platform-aware message selection.
/// </summary>
function SelectAllMessages()
{
    if (State.debug.logIO) 
    {
        console.log("[AIEnhancer] Using platform-aware message selection");
    }

    try
    {
        return PerformanceBenchmark.Measure('SelectAllMessages', () =>
        {
            const platform = State.currentPlatform;
            const adapter = State.currentAdapter;
            const root = document.querySelector("main") || document.querySelector("div[role='main']") || document.body;
            const collected = [];

            for (const selector of adapter.selectors)
            {
                try 
                {
                    root.querySelectorAll(selector).forEach(node => collected.push(node));
                } 
                catch (error) 
                {
                    if (State.debug.logIO) console.debug(`[AIEnhancer] Selector failed: ${selector}`, error);
                }
            }

            const unique = Array.from(new Set(collected));

            const topLevel = unique.filter(node =>
            {
                let parent = node.parentElement;

                while (parent)
                {
                    if (unique.includes(parent)) return false;

                    parent = parent.parentElement;
                }

                return true;
            });

            if (State.debug.logIO && topLevel.length > 0)
            {
                console.debug("[AIEnhancer] Detected:", platform, "Messages:", topLevel.length);
            }

            return topLevel;
        });
    }
    catch (error)
    {
        throw new NetworkError(`[AIEnhancer] Platform message selection failed: ${error.message}`, error);
    }
}

// --------------------------------------------------------------------------------
// Section: Platform-Aware Functions
// --------------------------------------------------------------------------------

/// <summary>
/// Detects the current AI platform based on window hostname.
/// Returns platform identifier string or 'unknown' if no match found.
/// </summary>
function DetectPlatform() 
{
    const hostname = window.location.hostname;
    
    if (hostname.includes('chat.deepseek.com')) return 'deepseek';
    if (hostname.includes('grok.com')) return 'grok';
    if (hostname.includes('claude.ai')) return 'claude';
    if (hostname.includes('gemini.google.com')) return 'gemini';
    if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) return 'chatgpt';
    
    return 'unknown';
}

/// <summary>
/// Determines whether platform-aware functions should be used for current platform.
/// Throws ConfigurationError if platform is explicitly unsupported.
/// </summary>
function ShouldUsePlatformAware() 
{   
    const platform = State.currentPlatform;

    if (platform === 'unknown') 
    {
        throw new ConfigurationError(`Unsupported platform: ${window.location.hostname}`);
    }

    return PlatformConfig.testing[platform] === true;
}

// --------------------------------------------------------------------------------
// Section: UI Components
// --------------------------------------------------------------------------------

/// <summary>
/// Creates the HUD panel with virtualiser toggle, character counter, and export button.
/// Safe to call multiple times - will not recreate if panel already exists.
/// </summary>
function CreatePanel(state) 
{
    if (state.panelElement && state.panelElement.isConnected) return;

    // Create HUD container
    const container = document.createElement("div");
    ApplyHudStyle(container);

    // Row 1: Virtualiser toggle and Copy button
    const toggleRow = document.createElement("div");
    toggleRow.style.display = "flex";
    toggleRow.style.alignItems = "center";
    toggleRow.style.justifyContent = "space-between";
    toggleRow.style.gap = "6px";

    const label = document.createElement("span");
    label.textContent = "Virtualiser:";

    const toggle = document.createElement("button");
    toggle.textContent = state.virtualiserEnabled ? "On" : "Off";
    ApplyButtonStyle(toggle);
    toggle.style.minWidth = "48px";
    toggle.style.color = state.virtualiserEnabled ? "lime" : "red";

    toggle.addEventListener("click", () => 
    {
        state.virtualiserEnabled = !state.virtualiserEnabled;
        toggle.textContent = state.virtualiserEnabled ? "On" : "Off";
        toggle.style.color = state.virtualiserEnabled ? "lime" : "red";

        // Save virtualiser state to localStorage
        try 
        {
            localStorage.setItem("ai_enhancer_virtualiser_on", JSON.stringify(state.virtualiserEnabled));
        } 
        catch (error) 
        {
            if (State.debug.logIO) console.debug("[AIEnhancer] Config failed to save virtualiser state:", error);
        }

        // If virtualiser was disabled, restore all messages immediately
        if (!state.virtualiserEnabled) 
        {
            RestoreAllMessages();

            try 
            { 
                state.observers?.intersection?.disconnect(); 
            } 
            catch (error) 
            {
                if (State.debug.logIO) console.warn("[AIEnhancer] IO Disconnect error:", error);
            }
            
            DisableLegacyPollingObserver(state);
        }
        else
        {
            EnsureIntersectionObserver(state);
            EnableLegacyPollingObserver(state); // IO will disable legacy when attached
        }
    });

    const copyButton = document.createElement("button");
    copyButton.textContent = "Copy";
    ApplyButtonStyle(copyButton);

    copyButton.addEventListener("click", () => 
    {
        CopyExportToClipboardAsync(state);
    });

    toggleRow.appendChild(label);
    toggleRow.appendChild(toggle);
    toggleRow.appendChild(copyButton);

    // Row 2: Counter and Export
    const secondRow = document.createElement("div");
    secondRow.style.display = "flex";
    secondRow.style.alignItems = "center";
    secondRow.style.justifyContent = "space-between";
    secondRow.style.gap = "8px";

    const counter = document.createElement("span");
    counter.textContent = `Est: 0 / ${state.maxChars}`;

    const exportButton = document.createElement("button");
    exportButton.textContent = "Export";
    ApplyButtonStyle(exportButton);

    exportButton.addEventListener("click", () => 
    {
        ExportConversationAsync(state);
    });

    secondRow.appendChild(counter);
    secondRow.appendChild(exportButton);

    // Assemble HUD
    container.appendChild(toggleRow);
    container.appendChild(secondRow);
    document.body.appendChild(container);

    // Save references in state for re-use
    state.panelElement = container;
    state.counterElement = counter;
}

/// <summary>
/// Updates the character counter display with current input length and appropriate colour.
/// Ensures HUD panel exists before updating.
/// </summary>
function UpdateCounter(state) 
{
    // Skip update if tab is hidden to save resources
    if (document.hidden) return;
    
    // Update last counter update time
    State.debug.stats.lastCounterUpdate = Date.now();

    // Always ensure the HUD exists (safe re-create if DOM was reset)
    CreatePanel(state);

    const inputText = GetActiveInputText();
    const length = inputText.length;

    if (state.counterElement) 
    {
        state.counterElement.textContent = `Est: ${length} / ${state.maxChars}`;
        state.counterElement.style.color = ChooseCounterColour(length, state);
    }
}

/// <summary>
/// Determines the appropriate colour for the character counter based on current length.
/// Returns red for over limit, gold for caution threshold, or default text colour.
/// </summary>
function ChooseCounterColour(length, state) 
{
    if (length > state.maxChars) return "red";
    if (length > state.cautionThreshold) return "gold";

    return "var(--text-primary, #ccc)";
}

/// <summary>
/// Retrieves the current text from the active input element detection using platform-specific selectors.
/// </summary>
function GetActiveInputText() 
{
    try
    {
        const adapter = State.currentAdapter; 

        // Priority 1: Currently focused element (universal)
        const activeElement = document.activeElement;

        if (activeElement && activeElement.tagName === "TEXTAREA") 
        {
            return activeElement.value || "";
        }

        if (activeElement && activeElement.getAttribute("contenteditable") === "true") 
        {
            return activeElement.innerText || "";
        }

        // Priority 2: Platform-specific input selectors
        for (const selector of adapter.inputSelectors) 
        {
            try 
            {
                const element = document.querySelector(selector);

                if (element) 
                {
                    return (element.value ?? element.innerText) || "";
                }
            } 
            catch (error) 
            {
                if (State.debug.logIO) console.debug(`[AIEnhancer] Input selector failed: ${selector}`, error);
            }
        }

        return "";
    }
    catch (error)
    {
        throw new ValidationError(`[AIEnhancer] Platform input detection failed: ${error.message}`, error);
    }
}
 
/// <summary>
/// Applies CSS styles to the HUD container for positioning and visual appearance.
/// Creates a semi-transparent overlay with backdrop blur and fixed positioning.
/// </summary>
function ApplyHudStyle(container) 
{
    container.className = 'AceHudContainer';
}

/// <summary>
/// Applies consistent button styling for toggle and export buttons.
/// Uses CSS custom properties for theme compatibility.
/// </summary>
function ApplyButtonStyle(button) 
{
    button.className = 'AceButton';
}

/// <summary>
/// Applies styling to placeholder elements used when messages are virtualised.
/// Creates a subtle visual indicator that content is hidden.
/// </summary>
function ApplyPlaceholderStyle(placeholder) 
{
    placeholder.className = 'AcePlaceholder';
    placeholder.textContent = "[Message hidden]";
}

// --------------------------------------------------------------------------------
// Section: Observers & Event Handlers
// --------------------------------------------------------------------------------

/// <summary>
/// Sets up MutationObserver to detect DOM changes and handle message node cleanup.
/// Uses requestAnimationFrame for performance optimisation and prevents duplicate processing.
/// </summary>
function EnsureMutationObserver(state)
{
    if (state.observers?.mutation)
    {
        try 
        { 
            state.observers.mutation.disconnect(); 
        } 
        catch (error) 
        {
            if (State.debug.logIO) console.warn("[AIEnhancer] MO Disconnect error:", error);
        }
    }

    // Flag to prevent duplicate requestAnimationFrame scheduling
    let rafScheduled = false;

    state.observers.mutation = new MutationObserver((mutationsList) =>
    {
        // Prevent duplicate processing if already scheduled
        if (rafScheduled) return;

        // Quick check: only process if mutations affect message-related nodes
        const messageSelectors = State.currentMessageSelectors;
        
        const hasMessageChanges = mutationsList.some(mutation => 
        {
            if (mutation.type !== 'childList') return false;
            
            // Check added nodes for message-related elements
            for (const node of mutation.addedNodes) 
            {
                if (node.nodeType === Node.ELEMENT_NODE && 
                    (node.matches?.(messageSelectors) || node.querySelector?.(messageSelectors))) 
                {
                    return true;
                }
            }
            
            // Check removed nodes for message-related elements
            for (const node of mutation.removedNodes) 
            {
                if (node.nodeType === Node.ELEMENT_NODE && 
                    (node.matches?.(messageSelectors) || node.querySelector?.(messageSelectors))) 
                {
                    return true;
                }
            }
            
            return false;
        });
        
        // Skip processing if no message-related changes detected
        if (!hasMessageChanges) return;

        rafScheduled = true;

        // Use requestAnimationFrame (rAF) for performance optimisation
        // rAF ensures DOM operations happen at optimal time
        requestAnimationFrame(() =>
        {
            rafScheduled = false;
            
            // Clean up observers for removed message nodes 
            const removedMessageNodes = mutationsList
                .filter(mutation => mutation.type === 'childList')
                .flatMap(mutation => Array.from(mutation.removedNodes))
                .filter(node => node.nodeType === Node.ELEMENT_NODE)
                .flatMap(element => 
                {
                    const isMessageNode = element.matches?.(messageSelectors);
                    
                    return isMessageNode 
                        ? [element] 
                        : Array.from(element.querySelectorAll?.(messageSelectors) || []);
                });

            // Clean up each removed message node
            removedMessageNodes.forEach(msgNode => 
            {
                 // Unobserve from IntersectionObserver
                 try 
                 { 
                     state.observers?.intersection?.unobserve(msgNode); 
                 } 
                 catch (error) 
                 {
                     if (State.debug.logIO) console.debug("[AIEnhancer] MO Unobserve failed:", error);
                 }
                
                // Clean up ResizeObserver
                const resizeObs = PlaceholderResizeObservers.get(msgNode);
                
                if (resizeObs) 
                {
                    resizeObs.disconnect();
                    PlaceholderResizeObservers.delete(msgNode);
                }
                
                // Clean up WeakMap entry (optional, GC will handle it)
                OriginalHtml.Delete(msgNode);
            });
            
            CreatePanel(state);
            EnsureIntersectionObserver(state);
            DisableLegacyPollingObserver(state); // IO attached will stop legacy; if IO finds none, it re-enables
            UpdateCounter(state);
        });
    });

    state.observers.mutation.observe(document.body, 
    {
        childList: true,
        subtree: true
    });
}

/// <summary>
/// Set up IntersectionObserver-based virtualisation.
/// Virtualise when off-screen, restore when intersecting.
/// Uses platform-specific detection for message elements.
/// </summary>
function EnsureIntersectionObserver(state) 
{
    if (state.observers?.intersection) 
    {
        try 
        { 
            state.observers.intersection.disconnect(); 
        } 
        catch (error) 
        {
            if (State.debug.logIO) console.warn("[AIEnhancer] IO disconnect error:", error);
        }
    }

    const topPx = Math.round(state.visibilityBuffer.top * window.innerHeight);
    const bottomPx = Math.round(state.visibilityBuffer.bottom * window.innerHeight);
    const rootMargin = `${topPx}px 0px ${bottomPx}px 0px`;

    // Create IntersectionObserver to monitor message visibility
    state.observers.intersection = new IntersectionObserver((entries) =>
    {
        for (const entry of entries)
        {
            const element = entry.target;
            
            // If virtualiser is disabled, restore any virtualised messages immediately
            if (!state.virtualiserEnabled)
            {
                if (element.dataset.virtualised) 
                {
                    RestoreMessage(element); 
                }

                continue;
            }

            // Message is now visible in viewport - restore if virtualised
            if (entry.isIntersecting)
            {
                if (element.dataset.virtualised)
                {
                    const Restore = () => { RestoreMessage(element); };

                    // Apply artificial delay if configured (for debugging)
                    if (State.debug.ioRestoreDelay > 0)
                    {
                        setTimeout(Restore, State.debug.ioRestoreDelay);
                    }
                    else
                    {
                        Restore();
                    }
                }
            }
            // Message is now outside viewport - virtualise if not already virtualised
            else
            {
                if (!element.dataset.virtualised)
                {
                    VirtualiseMessage(element);
                }
            }
        }

    }, { root: null, rootMargin });

    // Use platform-aware message selection
    const messages = SelectAllMessages();
    state.totalMessages = messages.length; // Total messages in the current conversation
    state.virtualisedCount = 0;            // Initially zero, updated as virtualisation occurs
    
    if (State.debug.logIO) 
    {
        console.log(`[AIEnhancer] IO observer initialized: ${messages.length} messages found`);
    }

    if (messages.length === 0)
    {
        if (State.debug.logIO) 
        {
            console.warn("[AIEnhancer] IO no messages found, enabling legacy fallback mode");
        }

        // Fallback: enable legacy scroll-based virtualiser if IO has no targets
        EnableLegacyPollingObserver(state);

        return;
    }

    for (const msg of messages)
    {
        state.observers.intersection.observe(msg);
    }

    // If legacy fallback was running, stop it once IO attaches successfully
    DisableLegacyPollingObserver(state);
}

/// <summary>
/// Binds global event listeners for input changes to trigger counter updates.
/// Uses capture phase to ensure events are caught even if bubbling is stopped.
/// </summary>
function BindGlobalEvents(state) 
{
    state.InputHandler = () => UpdateCounter(state);

    // Background tab power saving: pause legacy polling when tab is hidden
    state.VisibilityHandler = () => 
    {
        if (document.hidden) 
        {
            // Tab is hidden - stop legacy polling to save power
            DisableLegacyPollingObserver(state);
        }
        else if (state.virtualiserEnabled) 
        {
            // Tab is visible again - restart virtualisation if enabled
            EnsureIntersectionObserver(state);
            EnableLegacyPollingObserver(state);
            UpdateCounter(state);
        }
    };

    // Event handlers
    document.addEventListener("input", state.InputHandler, true);
    document.addEventListener("keyup", state.InputHandler, true);
    document.addEventListener("visibilitychange", state.VisibilityHandler, true);
}

/// <summary>
/// Starts the background counter update loop using intelligent scheduling.
/// Ensures counter stays updated even when user is not actively typing.
/// </summary>
function StartLoops(state) 
{
    // Skip update if tab is hidden to save resources
    if (document.hidden) 
    {
        if (State.debug.logIO) 
        {
            console.log("[AIEnhancer] Background: skipping StartLoops");
        }

        return;
    }

    // Check if counter loop is already running
    if (document.hidden || state.timers.counterRunning || state.timers.counterHandler) 
    {
        if (State.debug.logIO) console.log("[AIEnhancer] Counter loop already running");

        return;
    }

    const idleCallbackTimeout = 1000;                           // Idle callback timeout fallback (ms)
    const counterUpdateInterval = 1500;                         // Counter update interval (ms)
    const minimumTimeRequired = 5;                              // Minimum time required for idle callback (ms)
    state.timers.counterRunning = true;                         // Set operational flag
    
    let isCancelled = false;

    // Unified update function with timing control
    const PerformUpdate = () => 
    {
        if (document.hidden || isCancelled || !state.timers.counterRunning) return;
        
        UpdateCounter(state);
    };

    // Modern browsers: Use requestIdleCallback for better performance when available
    if (window.requestIdleCallback) 
    {
        const ScheduleIdleUpdate = () => 
        {
            if (document.hidden || isCancelled || !state.timers.counterRunning) return;

            const callbackId = window.requestIdleCallback((deadline) =>
            {
                if (document.hidden || isCancelled || !state.timers.counterRunning) return;
    
                // Execute update if we have time remaining or timeout
                if (deadline.timeRemaining() > minimumTimeRequired || deadline.didTimeout) 
                {
                    PerformUpdate();
                }

                if (document.hidden || !isCancelled && state.timers.counterRunning) 
                {
                    ScheduleIdleUpdate();
                }

            }, { timeout: idleCallbackTimeout }); // Timeout for safety

            state.timers.counterHandler = callbackId;
        };
    
        // Start the idle callback cycle
        ScheduleIdleUpdate();
    }
    // Fallback for older browsers: Use setInterval
    else 
    {
        state.timers.counterHandler = setInterval(() => 
        {
            if (document.hidden || isCancelled || !state.timers.counterRunning) return;
            
            PerformUpdate();

        }, counterUpdateInterval); // Less frequent updates for better performance
    }

    // Stop the counter update loop
    state.timers.StopCounter = () => 
    {
        isCancelled = true;
        state.timers.counterRunning = false;
        
        // Clean up the counter handler
        if (typeof state.timers.counterHandler === 'number') 
        {
            window.cancelIdleCallback?.(state.timers.counterHandler);
        } 
        else 
        {
            clearInterval(state.timers.counterHandler);
        }
        
        state.timers.counterHandler = null;
    };
}

/// <summary>
/// Enables legacy polling-based visibility observation as fallback mechanism.
/// Uses active interval polling to monitor element visibility when modern
/// IntersectionObserver API is unavailable or ineffective.
/// </summary>
function EnableLegacyPollingObserver(state)
{
    if (state.timers.legacyVirtualiserHandler) return;

    const Tick = () =>
    {
        if (!state.virtualiserEnabled) return;

        const messages = SelectAllMessages();
        const viewportHeight = window.innerHeight;
        const scrollTop = window.scrollY || document.documentElement.scrollTop;

        for (const msg of messages)
        {
            const rect = msg.getBoundingClientRect();
            const elementTop = rect.top + scrollTop;
            const elementBottom = elementTop + rect.height;

            const bufferTop = viewportHeight * state.visibilityBuffer.top;
            const bufferBottom = viewportHeight * state.visibilityBuffer.bottom;

            // Check if element is within the visible area (including buffer zones)
            const visible = 
                (elementBottom >= scrollTop - bufferTop) && 
                (elementTop <= scrollTop + viewportHeight + bufferBottom);

            if (!visible && !msg.dataset.virtualised)
            {
                VirtualiseMessage(msg);
            }
            else if (visible && msg.dataset.virtualised)
            {
                RestoreMessage(msg);
            }
        }
    };

    // Poll every 800ms for legacy virtualisation
    const legacyPollingInterval = 800;
    state.timers.legacyVirtualiserHandler = setInterval(Tick, legacyPollingInterval);
    window.addEventListener("scroll", Tick, { passive: true });
    window.addEventListener("resize", Tick, { passive: true });
}

/// <summary>
/// Disables the legacy polling observer and releases all associated resources.
/// Called when modern IntersectionObserver becomes available or during cleanup.
/// </summary>
function DisableLegacyPollingObserver(state)
{
    if (!state.timers.legacyVirtualiserHandler) return;

    clearInterval(state.timers.legacyVirtualiserHandler);
    state.timers.legacyVirtualiserHandler = null;
}

// --------------------------------------------------------------------------------
// Section: Export & Serialisation
// --------------------------------------------------------------------------------

/// <summary>
/// Converts minimal HTML produced messages into Markdown.
/// This is a lightweight, dependency-free converter covering common tags.
/// </summary>
function ConvertHtmlToMarkdown(html)
{
    if (!html) return "";

    // Work on a detached DOM
    const div = document.createElement("div");
    div.innerHTML = html;

    // 1) Code blocks: <pre><code class="language-xxx">...</code></pre> → ```xxx ... ```
    div.querySelectorAll("pre code").forEach(code =>
    {
        const lang = (code.className.match(/language-([a-z0-9+-]+)/i) || [,""])[1];
        const content = code.textContent.replace(/\s+$/,"");
        const fence = "```" + lang + "\n" + content + "\n```";
        const pre = code.closest("pre");

        if (pre)
        {
            const replacement = document.createElement("p");
            replacement.textContent = fence; // temp
            pre.replaceWith(replacement);
        }
    });

    // 2) Inline code: <code> → `...`
    div.querySelectorAll("code").forEach(code =>
    {
        if (code.closest("pre")) return; // handled above

        const txt = code.textContent;
        const span = document.createTextNode("`" + txt + "`");
        code.replaceWith(span);
    });

    // 3) Bold / Italic
    div.querySelectorAll("b,strong").forEach(element =>
    {
        element.replaceWith(document.createTextNode("**" + element.textContent + "**"));
    });

    div.querySelectorAll("i,em").forEach(element =>
    {
        element.replaceWith(document.createTextNode("_" + element.textContent + "_"));
    });

    // 4) Links: <a href="...">text</a> → [text](url)
    div.querySelectorAll("a[href]").forEach(a =>
    {
        const url = a.getAttribute("href") || "";
        const text = a.textContent || url;
        a.replaceWith(document.createTextNode("[" + text + "](" + url + ")"));
    });

    // 5) Images: <img alt src> → ![alt](src)
    div.querySelectorAll("img[src]").forEach(img =>
    {
        const alt = img.getAttribute("alt") || "";
        const src = img.getAttribute("src") || "";
        img.replaceWith(document.createTextNode("![" + alt + "](" + src + ")"));
    });

    // 6) Lists
    div.querySelectorAll("ul").forEach(unorderedList =>
    {
        const lines = [];

        unorderedList.querySelectorAll(":scope > li").forEach(listItem =>
        {
            lines.push("- " + (listItem.textContent || "").trim());
        });
        
        const paragraph = document.createElement("p");
        paragraph.textContent = lines.join("\n");
        unorderedList.replaceWith(paragraph);
    });

    div.querySelectorAll("ol").forEach(orderedList =>
    {
        let index = 1;
        const lines = [];

        orderedList.querySelectorAll(":scope > li").forEach(listItem =>
        {
            lines.push((index++) + ". " + (listItem.textContent || "").trim());
        });

        const paragraph = document.createElement("p");
        paragraph.textContent = lines.join("\n");
        orderedList.replaceWith(paragraph);
    });

    // 7) Line breaks / paragraphs
    div.querySelectorAll("br").forEach(lineBreak =>
    {
        lineBreak.replaceWith(document.createTextNode("\n"));
    });

    // Normalise block separators: <p>, <div>
    const blockJoin = [];

    Array.from(div.childNodes).forEach(node =>
    {
        const text = (node.textContent || "").trim();
        if (text) blockJoin.push(text);
    });

    // Final cleanup
    let md = blockJoin.join("\n\n");
    md = md.replace(/\u00A0/g, " ");     // nbsp → space
    md = md.replace(/\r\n/g, "\n");      // CRLF → LF

    return md;
}

/// <summary>
/// Returns HTML of a message and NEVER yields the placeholder,
/// even if node cache is missing. If virtualised but OriginalNodes is empty,
/// it performs a temporary restore-extract-revirtualise without visual flicker.
/// </summary>
function ExtractMessageHTML(message)
{
    // Not virtualised: normal path
    if (message.dataset.virtualised !== "1")
    {
        return message.innerHTML;
    }

    // Expected node-virtualised path
    const nodes = OriginalNodes.get(message) || [];

    if (nodes.length > 0)
    {
        const frag = document.createDocumentFragment();

        for (const node of nodes)
        {
            frag.appendChild(node.cloneNode(true));
        }

        const div = document.createElement("div");
        div.appendChild(frag);
        
        return div.innerHTML;
    }

    // Fallback: the cache is missing (key swapped/GC/re-render)
    // Do a silent round-trip: restore → read → re-virtualise
    // Keep it invisible to avoid flicker
    const previousVisibility = message.style.visibility;
    const wasVirtualised = true;

    try
    {
        message.style.visibility = "hidden";
        RestoreMessage(message);

        const html = message.innerHTML;

        // Re-virtualise back so on-screen state doesn't change
        if (wasVirtualised)
        {
            VirtualiseMessage(message);
        }

        return html;
    }
    catch (error)
    {
        // Last-resort fallback (should be rare)
        try { return message.innerHTML; } catch { return ""; }
    }
    finally
    {
        message.style.visibility = previousVisibility || "";
    }
}

/// <summary>
/// Generates markdown by extracting each message with user/assistant labels.
/// Now supports both legacy and platform-aware modes.
/// </summary>
function GenerateMarkdown()
{
    const messages = SelectAllMessages();
    const chunks = [];

    for (const msg of messages)
    {
        const html = ExtractMessageHTML(msg);
        const markdown = ConvertHtmlToMarkdown(html);

        // Platform-aware role detection or fallback to legacy
        const role = ShouldUsePlatformAware() ? 
            State.currentAdapter.messageRole(msg) :
            (msg.getAttribute("data-message-author-role") || "message");

        const label = role === "user" ? "### User" : 
                     role === "assistant" ? "### Assistant" : "### Message";

        chunks.push(`${label}\n\n${markdown}`);
    }

    return chunks.join("\n\n---\n\n");
}

/// <summary>
/// Try to get a stable, human-readable thread title; avoid UUID paths and illegal characters.
/// </summary>
function GetThreadTitle()
{
    // Prefer visible conversation title in sidebar/header
    let title =
        document.querySelector("nav [aria-current='page'] span")?.textContent ||
        document.querySelector("header h1")?.textContent ||
        document.querySelector("title")?.textContent ||
        location.pathname.split("/").filter(Boolean).pop() || "chat";

    title = (title || "chat").trim();

    // Filter out UUID-like strings (common in URLs)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(title))
    {
        title = "chat";
    }

    // Sanitize file name characters (remove illegal Windows/Unix filename characters)
    title = title.replace(/[\\/:*?"<>|]/g, "").slice(0, 120) || "chat";

    return title;
}

/// <summary>
/// Performs the actual export operation, creating a Markdown file with conversation content.
/// Extracts role-based sections and downloads the file with a sanitised filename.
/// </summary>
function ExportToFile() 
{
    const threadTitle = GetThreadTitle();
    const exportPayload = GenerateMarkdown();

    const blob = new Blob([exportPayload], { type: "text/markdown" });
    const anchor = document.createElement("a");

    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${threadTitle}.md`;
    anchor.click();

    // Clean up blob URL after 1 second
    const blobCleanupDelay = 1000;
    setTimeout(() => URL.revokeObjectURL(anchor.href), blobCleanupDelay);
}

/// <summary>
/// Export current conversation as Markdown with role-based sections. Title comes from page.
/// </summary>
async function ExportConversationAsync(state) 
{
    await RunWithMessagesRestoredAsync(state, async () => 
    {
        ExportToFile();
    });
}

/// <summary>
/// Copies the current conversation as Markdown to the clipboard.
/// Clipboard APIs can be blocked by permissions/policy; errors are swallowed to avoid breaking UX.
/// </summary>
async function CopyExportToClipboardAsync(state) 
{
    await RunWithMessagesRestoredAsync(state, async () => 
    {
        const md = GenerateMarkdown();

        try 
        {
            await navigator.clipboard.writeText(md);
        } 
        catch (error) 
        {
            if (State.debug.logIO) console.debug("[AIEnhancer] Copy clipboard write failed:", error);
        }
    });
}

/// <summary>
/// Executes an async action while messages are fully restored (virtualisation temporarily disabled).
/// Always restores the previous virtualisation state (and observers) even if the action throws.
/// </summary>
async function RunWithMessagesRestoredAsync(state, actionAsync) 
{
    // Temporarily restore all messages to ensure complete export
    const wasEnabled = state.virtualiserEnabled;
    state.virtualiserEnabled = false;
    RestoreAllMessages();
    
    // Wait for 2 frames to ensure DOM is fully updated before export
    await WaitForFrames(2); 
    
    try 
    { 
        return await actionAsync(); 
    }
    finally 
    {
        state.virtualiserEnabled = wasEnabled;

        if (wasEnabled) 
        {
            EnsureIntersectionObserver(state);
            EnableLegacyPollingObserver(state);
        }
    }
}

// --------------------------------------------------------------------------------
// Section: Utilities
// --------------------------------------------------------------------------------

/// <summary>
/// Waits for a specified number of animation frames using requestAnimationFrame.
/// More reliable than setTimeout for frame-based timing.
/// </summary>
function WaitForFrames(frameCount) 
{
    return new Promise(Resolve => 
    {
        let frames = 0;
        
        const CheckFrame = () => 
        {
            frames++;
            
            if (frames >= frameCount) 
            {
                Resolve();
            } 
            else 
            {
                requestAnimationFrame(CheckFrame);
            }
        };
        
        requestAnimationFrame(CheckFrame);
    });
}

/// <summary>
/// Handles initialisation errors gracefully.
/// </summary>
function HandleInitialisationError(error) 
{
    if (error instanceof ConfigurationError)
    {
        console.error("[AIEnhancer] Configuration error:", error.message);
    }
    else
    {
        console.error("[AIEnhancer] Initialisation failed:", error);
    }
}

// --------------------------------------------------------------------------------
// Section: Debugging and Maintenance
// --------------------------------------------------------------------------------

// ------------------------------------------------------------
// Performance Optimisation & Resource Management
// ------------------------------------------------------------

/// <summary>
/// Sets up comprehensive page visibility management, triggered early for resource conservation
/// </summary>
function SetupVisibilityManagement(state) 
{
    // Remove old listener to avoid duplicates
    if (state.VisibilityHandler) 
    {
        document.removeEventListener('visibilitychange', state.VisibilityHandler);
    }
    
    state.VisibilityHandler = () => 
    {
        if (document.hidden) 
        {
            PauseBackgroundActivities(state);
        } 
        else 
        {
            ResumeBackgroundActivities(state);
        }
    };
    
    document.addEventListener('visibilitychange', state.VisibilityHandler);
}

/// <summary>
/// Pauses all background activities to conserve resources
/// </summary>
function PauseBackgroundActivities(state) 
{
    if (state.debug.logIO) 
    {
        console.log("[AIEnhancer] Background entered: pausing all activities");
    }
    
    // Pause timer loops
    if (state.timers.StopCounter) 
    {
        state.timers.StopCounter();
    }
    
    // Pause Legacy Polling Observer
    DisableLegacyPollingObserver(state);
}

/// <summary>
/// Resumes background activities
/// </summary>
function ResumeBackgroundActivities(state) 
{
    if (state.debug.logIO) 
    {
        console.log("[AIEnhancer] Foreground returned: resuming activities");
    }
    
    // Resume only if virtualisation is enabled
    if (state.virtualiserEnabled) 
    {
        StartLoops(state);
        EnsureIntersectionObserver(state);
    }
}

// ------------------------------------------------------------
// Comprehensive Cleanup Handlers (Single Responsibility)
// ------------------------------------------------------------

/// <summary>
/// Cleans up the counter stop delegate and releases associated resources
/// </summary>
function CleanupCounterDelegate(state) 
{
    if (state.timers.StopCounter) 
    {
        try 
        {
            // Execute the cleanup delegate
            state.timers.StopCounter();
            // Release the delegate reference
            state.timers.StopCounter = null;
        } 
        catch (error) 
        {
            if (state.debug.logIO) 
            {
                console.warn("[AIEnhancer] StopCounter cleanup error:", error);
            }
        }
    }
}

/// <summary>
/// Cleans up all Observer instances
/// </summary>
function CleanupAllObservers(state) 
{
    // IntersectionObserver
    try 
    { 
        state.observers?.intersection?.disconnect(); 
        state.observers.intersection = null;
    } 
    catch (error) 
    {
        if (state.debug.logIO) 
        {
            console.warn("[AIEnhancer] IO cleanup error:", error);
        }
    }
    
    // MutationObserver
    try 
    { 
        state.observers?.mutation?.disconnect(); 
        state.observers.mutation = null;
    } 
    catch (error) 
    {
        if (state.debug.logIO) 
        {
            console.warn("[AIEnhancer] MO cleanup error:", error);
        }
    }
    
    // Cleanup all ResizeObserver instances
    CleanupResizeObservers();
}

/// <summary>
/// Cleans up all ResizeObserver instances
/// </summary>
function CleanupResizeObservers() 
{
    PlaceholderResizeObservers.forEach(observer => 
    {
        try 
        {
            observer.disconnect();
        } 
        catch (error) 
        {
            if (State.debug.logIO) 
            {
                console.debug("[AIEnhancer] ResizeObserver cleanup error:", error);
            }
        }
    });

    PlaceholderResizeObservers.clear();
}

/// <summary>
/// Cleans up all timer-related resources
/// </summary>
function CleanupAllTimers(state) 
{
    // Cleanup counterHandler
    if (state.timers.counterHandler) 
    {
        if (typeof state.timers.counterHandler === 'number') 
        {
            window.cancelIdleCallback?.(state.timers.counterHandler);
        } 
        else 
        {
            clearInterval(state.timers.counterHandler);
        }

        state.timers.counterHandler = null;
    }
    
    // Pause Legacy Polling Observer
    DisableLegacyPollingObserver(state);
    
    // Reset status flags
    state.timers.counterRunning = false;
}

/// <summary>
/// Cleans up all DOM element references
/// </summary>
function CleanupDomReferences(state) 
{
    state.panelElement = null;
    state.counterElement = null;
    
    // Cleanup other potential DOM references
    if (state.cachedElements) 
    {
        state.cachedElements = null;
    }
}

/// <summary>
/// Cleans up all event listeners
/// </summary>
function CleanupEventListeners(state) 
{
    // Cleanup visibilitychange listener
    if (state.VisibilityHandler) 
    {
        document.removeEventListener('visibilitychange', state.VisibilityHandler);
        state.VisibilityHandler = null;
    }
    
    // Cleanup inputchange listener
    if (state.InputHandler) 
    {
        document.removeEventListener('input', state.InputHandler);
        document.removeEventListener('keyup', state.InputHandler);
        state.InputHandler = null;
    }
}

/// <summary>
/// Cleans up all cached data
/// </summary>
function CleanupCachedData(state) 
{
    // Cleanup platform detection cache
    state.currentPlatform = null;
    state.currentAdapter = null;
    state.currentMessageSelectors = '';
    state.currentInputSelectors = '';
    
    // Cleanup statistics data
    state.debug.stats = 
    {
        virtualisedCount: 0,
        lastUpdateTime: 0,
        lastCounterUpdate: 0
    };
    
    // Clear LRU Cache (WeakMap will be handled by GC automatically)
    OriginalHtml.Clear();
}

// ------------------------------------------------------------
// Core Cleanup Function (Orchestrator)
// ------------------------------------------------------------

/// <summary>
/// Performs complete cleanup of all observers, timers, and stored data.
/// Uses delegate pattern for proper resource cleanup.
/// </summary>
function Cleanup(state) 
{
    // Execute delegate cleanup first
    CleanupCounterDelegate(state);

    CleanupAllObservers(state); 
    CleanupAllTimers(state);           
    CleanupEventListeners(state);    
    CleanupDomReferences(state);     
    CleanupCachedData(state);        
    
    if (state.debug.logIO) console.log("[AIEnhancer] Cleanup completed: All resources released");
}

// ------------------------------------------------------------
// Debug Helpers (Console Access)
// ------------------------------------------------------------

/// <summary>
/// Generates a debug report with current virtualiser state and statistics.
/// Available globally as window.ACE.Debug() for console debugging.
/// </summary>
function DebugReport() 
{
    const report = 
    {
        totalMessages: State.totalMessages || 0,
        virtualisedCount: State.debug.stats.virtualisedCount || 0,
        ioAttached: !!State.observers?.intersection,
        fallbackRunning: !!State.timers?.legacyVirtualiserHandler,
        bufferTop: State.visibilityBuffer?.top || 0.5,
        bufferBottom: State.visibilityBuffer?.bottom || 0.5,
        
        memoryUsage: performance.memory ? 
        {
            used: Math.round(performance.memory.usedJSHeapSize / BytesPerMegabyte),
            total: Math.round(performance.memory.totalJSHeapSize / BytesPerMegabyte),
            limit: Math.round(performance.memory.jsHeapSizeLimit / BytesPerMegabyte)
        } : null,
        
        performance: 
        {
            lastUpdateTime: State.debug.stats.lastUpdateTime,
            virtualisedCount: State.debug.stats.virtualisedCount
        }
    };

    try { console.log("[AIEnhancer] Debug Report:", report); } 
    catch (error) { console.debug("[AIEnhancer] Debug log failed:", error); }

    return report;
}

/// <summary>
/// Sets up global debug and utility functions for window.ACE (AI Chat Enhancer).
/// </summary>
function SetupGlobalDebug() 
{   
    try 
    {
        window.ACE = window.ACE || {};
        window.ACE.Debug = () => DebugReport();

        window.ACE.SetIoRestoreDelay = (ms) => 
        { 
            State.debug.ioRestoreDelay = Number(ms) || 0; 

            return State.debug.ioRestoreDelay; 
        };

        window.ACE.EnableIoLogging = (on) => 
        { 
            State.debug.logIO = !!on; 

            return State.debug.logIO; 
        };

        window.ACE.Cleanup = () => Cleanup(State);

        window.ACE.CheckStateSync = () => 
        {
            const actual = document.querySelectorAll('[data-virtualised="1"]').length;
            
            const result = 
            {
                stateReport: State.debug.stats.virtualisedCount,
                actualCount: actual,
                isSynchronized: State.debug.stats.virtualisedCount === actual
            };

            return result;
        };

        window.ACE.ForceRefresh = () => 
        {
            if (State?.observers?.intersection) 
            {
                State.observers.intersection.disconnect();
            }

            EnsureIntersectionObserver(State);
        };

        // Enables tracking of state property changes for debugging purposes
        window.ACE.TrackStateChanges = () => 
        {
            let changeCount = 0;
            const trackedProperties = ['totalMessages', 'virtualisedCount'];
                
            trackedProperties.forEach(prop => 
            {
                const originalValue = State[prop];

                Object.defineProperty(State, prop, 
                {
                    Set(value) 
                    {
                            console.log(`[AIEnhancer] State.${prop} changed: ${originalValue} → ${value}`);
                            console.trace('[AIEnhancer] Modification stack trace');
                            
                            changeCount++;
                            this.value = value;
                    },
                    Get() { return this.value; }
                });

                State[prop] = originalValue; // Reset initial value
            });
            
            console.log(`[AIEnhancer] State change tracking enabled for: ${trackedProperties.join(', ')}`);
        }

        // Performance monitoring and cache management functions
        window.ACE.GetPerformanceStats = (name) => PerformanceBenchmark.GetStats(name);
        window.ACE.ClearPerformanceStats = () => PerformanceBenchmark.Clear();

        window.ACE.GetCacheStats = () => 
        ({ 
            size: OriginalHtml.size, 
            maxSize: OriginalHtml.maxSize 
        });

        window.ACE.ClearCache = () => OriginalHtml.Clear();
    } 
    catch (error) 
    {
        // Global object setup failed - log but don't break the script
        console.debug("[AIEnhancer] ACE setup failed:", error);
    }
}

// --------------------------------------------------------------------------------
// Section: Entry Point
// --------------------------------------------------------------------------------

/// <summary>
/// Entry point: creates HUD, binds events, starts counter loop, and initialises observers.
/// IO is primary; legacy fallback activates only when IO finds no targets.
/// </summary>
function Main()
{
    try 
    {
        InitialisePlatformDetection(State);
        SetupVisibilityManagement(State);
        InitialiseCoreComponents(State);    
        InitialisePlatformFeatures(State);  
        InitialiseDebuggingTools(State);    
    } 
    catch (error) 
    { 
        HandleInitialisationError(error); 
    }
}

// Auto-execute when script loads - initialises all components and starts monitoring
CheckBrowserSupport();
InitialiseState(State);

Main();

