/**
 * GPT-SoVITS TTS Player for SillyTavern
 * 完整移植自油猴脚本 v18.7
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";

const extensionName = "ST-GPT-SoVITS-Extension";
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}/`;

const DO_NOT_PLAY_VALUE = '_DO_NOT_PLAY_';
const DEFAULT_DETECTION_MODE = 'character_and_dialogue';

// 默认设置
const defaultSettings = {
    ttsApiBaseUrl: 'http://127.0.0.1:8000',
    ttsApiVersion: 'v4',
    detectionMode: DEFAULT_DETECTION_MODE,
    speedFacter: 1.0,
    emotion: '默认',
    narrationVoice: '',
    dialogueVoice: '',
    characterVoices: {},
    characterGroups: {},
    defaultVoice: '',
    allDetectedCharacters: [],
    maxConcurrentGenerations: 3,
    preloadEnabled: true,
    batchMode: true,
    autoPlayEnabled: false,
    quotationStyle: 'japanese',
    edgeMode: false,
    frontendAdaptationEnabled: false,
    isSingleCharacterMode: false,
    singleCharacterTarget: ''
};

// 运行时变量
let ttsApiBaseUrl = "http://127.0.0.1:8000";
let TTS_API_ENDPOINT_INFER = "";
let TTS_API_ENDPOINT_MODELS = "";
let ttsApiVersion = 'v4';
let detectionMode = DEFAULT_DETECTION_MODE;
let speedFacter = 1.0;
let emotion = '默认';
let narrationVoice = '';
let dialogueVoice = '';
let ttsModels = [], ttsModelsWithDetails = {}, characterVoices = {}, defaultVoice = '';
let allDetectedCharacters = new Set();
let lastMessageParts = [];
let generationQueue = [], playbackQueue = [], lastPlayedQueue = [];
let isPlaying = false, isPaused = false, currentAudio = null;
let isProcessingQueue = false;
let currentPlaybackIndex = 0;
let playbackSequenceId = 0;
let audioCache = new Map();
let generationPromises = new Map();
let maxConcurrentGenerations = 3;
let currentGenerations = 0;
let preloadEnabled = true;
let autoPlayEnabled = false;
let quotationStyle = 'japanese';
let frontendAdaptationEnabled = false;
let isSingleCharacterMode = false;
let singleCharacterTarget = '';
let lastProcessedMessageId = null;
let lastProcessedText = '';
let autoPlayTimeout = null;
let isEdgeHidden = false;
let originalPosition = null;
let edgeIndicatorLastTop = null;
let batchMode = true;
let edgeMode = false;
let characterGroups = {};

// 控制台日志存储
let consoleLogs = [];
let originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info
};

// 初始化日志捕获
function initConsoleLogger() {
    console.log = function (...args) {
        originalConsole.log.apply(console, args);
        consoleLogs.push({
            type: 'log',
            message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' '),
            timestamp: new Date().toLocaleTimeString()
        });
    };
    console.warn = function (...args) {
        originalConsole.warn.apply(console, args);
        consoleLogs.push({
            type: 'warn',
            message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' '),
            timestamp: new Date().toLocaleTimeString()
        });
    };
    console.error = function (...args) {
        originalConsole.error.apply(console, args);
        consoleLogs.push({
            type: 'error',
            message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' '),
            timestamp: new Date().toLocaleTimeString()
        });
    };
    console.info = function (...args) {
        originalConsole.info.apply(console, args);
        consoleLogs.push({
            type: 'info',
            message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' '),
            timestamp: new Date().toLocaleTimeString()
        });
    };
}

// 创建通知容器
function createNotificationContainer() {
    const container = document.createElement('div');
    container.id = 'tts-notification-container';
    document.body.appendChild(container);
    return container;
}

// 显示通知
function showNotification(message, type = 'info', duration = 3000) {
    const container = document.getElementById('tts-notification-container') || createNotificationContainer();
    const notification = document.createElement('div');
    notification.className = `tts-notification ${type}`;
    notification.textContent = message;
    container.appendChild(notification);
    setTimeout(() => notification.classList.add('show'), 100);
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            if (notification.parentNode) notification.parentNode.removeChild(notification);
        }, 300);
    }, duration);
}

// 显示控制台日志查看器
// 显示控制台日志查看器
function showConsoleLogger() {
    const existingModal = document.getElementById('console-logger-modal');
    if (existingModal) { existingModal.remove(); return; }

    const modal = $(`
        <div id="console-logger-modal" class="tts-modal">
            <div class="tts-modal-content">
                <div class="tts-modal-header">
                    <h2><i class="icon">📋</i> 控制台日志查看器</h2>
                    <div class="header-buttons">
                        <button id="clear-logs-btn" class="tts-header-btn" title="清空日志"><i class="icon">🗑️</i></button>
                        <button id="refresh-logs-btn" class="tts-header-btn" title="刷新日志"><i class="icon">🔄</i></button>
                        <button class="tts-close-btn">×</button>
                    </div>
                </div>
                <div class="tts-modal-body" style="padding:0; display:flex; flex-direction:column; overflow:hidden;">
                    <div class="tts-log-toolbar">
                        <div class="tts-log-filters">
                            <label style="font-weight:600;">日志类型过滤：</label>
                            <label class="tts-log-filter-item"><input type="checkbox" id="filter-log" checked> Log</label>
                            <label class="tts-log-filter-item"><input type="checkbox" id="filter-warn" checked> Warn</label>
                            <label class="tts-log-filter-item"><input type="checkbox" id="filter-error" checked> Error</label>
                            <label class="tts-log-filter-item"><input type="checkbox" id="filter-info" checked> Info</label>
                            <span id="log-count" class="tts-log-count">共 0 条日志</span>
                        </div>
                    </div>
                    <div id="log-container" class="tts-log-container"></div>
                </div>
            </div>
        </div>
    `);

    $('body').append(modal);

    function renderLogs() {
        const filters = {
            log: $('#filter-log').is(':checked'),
            warn: $('#filter-warn').is(':checked'),
            error: $('#filter-error').is(':checked'),
            info: $('#filter-info').is(':checked')
        };
        const filteredLogs = consoleLogs.filter(log => filters[log.type]);
        $('#log-count').text(`共 ${filteredLogs.length} 条日志`);

        // 使用 CSS 变量或预定义颜色，这里保留 hex 以兼容现有逻辑
        const typeColors = { log: '#d4d4d4', warn: '#f59e0b', error: '#ef4444', info: '#3b82f6' };
        const typeIcons = { log: '📝', warn: '⚠️', error: '❌', info: 'ℹ️' };

        $('#log-container').html(filteredLogs.map(log => `
            <div class="tts-log-entry" style="border-left-color: ${typeColors[log.type]}">
                <div class="tts-log-header">
                    <span style="color:${typeColors[log.type]};">${typeIcons[log.type]} [${log.type.toUpperCase()}]</span>
                    <span class="tts-log-timestamp">${log.timestamp}</span>
                </div>
                <div class="tts-log-message" style="color:${typeColors[log.type]};">${log.message}</div>
            </div>
        `).join(''));

        const container = $('#log-container')[0];
        container.scrollTop = container.scrollHeight;
    }

    renderLogs();
    modal.find('.tts-close-btn').on('click', () => modal.remove());
    modal.on('click', e => { if (e.target === modal[0]) modal.remove(); });
    $('#clear-logs-btn').on('click', () => { consoleLogs = []; renderLogs(); });
    $('#refresh-logs-btn').on('click', renderLogs);
    ['filter-log', 'filter-warn', 'filter-error', 'filter-info'].forEach(id => $(`#${id}`).on('change', renderLogs));
}

// ========== 边缘隐藏功能 ==========
function toggleEdgeHide() {
    const panel = document.getElementById('tts-floating-panel');
    if (!panel) return;
    if (isEdgeHidden) {
        showPanel();
    } else {
        hideToEdge();
    }
}

function hideToEdge() {
    const panel = document.getElementById('tts-floating-panel');
    if (!panel) return;

    // 保存当前位置
    const rect = panel.getBoundingClientRect();
    originalPosition = {
        left: panel.style.left,
        top: panel.style.top,
        right: panel.style.right,
        bottom: panel.style.bottom,
        transform: panel.style.transform
    };

    // 移动到右侧边缘
    panel.style.left = 'auto';
    panel.style.top = '50%';
    panel.style.right = '-200px';
    panel.style.bottom = 'auto';
    panel.style.transform = 'translateY(-50%)';
    panel.classList.add('edge-hidden');
    isEdgeHidden = true;

    createEdgeIndicator();

    const hideBtn = document.getElementById('tts-hide-btn');
    if (hideBtn) {
        hideBtn.innerHTML = '<i class="icon">👁‍🗨</i>';
        hideBtn.title = '显示面板';
    }
    showNotification('面板已隐藏到边缘，点击右侧角标可显示', 'info');
}

function showPanel() {
    const panel = document.getElementById('tts-floating-panel');
    if (!panel) return;

    removeEdgeIndicator();

    if (originalPosition) {
        panel.style.left = originalPosition.left;
        panel.style.top = originalPosition.top;
        panel.style.right = originalPosition.right;
        panel.style.bottom = originalPosition.bottom;
        panel.style.transform = originalPosition.transform;
    } else {
        panel.style.left = '50%';
        panel.style.top = '50%';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'translate(-50%, -50%)';
    }

    panel.classList.remove('edge-hidden');
    isEdgeHidden = false;

    const hideBtn = document.getElementById('tts-hide-btn');
    if (hideBtn) {
        hideBtn.innerHTML = '<i class="icon">👁</i>';
        hideBtn.title = '边缘隐藏';
    }
    showNotification('面板已显示', 'info');
}

function createEdgeIndicator() {
    removeEdgeIndicator();

    const indicator = document.createElement('div');
    indicator.id = 'tts-edge-indicator';
    indicator.className = 'tts-edge-indicator';
    indicator.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18px" height="18px"><path d="M15.707 17.707a1 1 0 0 1-1.414 0L9 12.414l5.293-5.293a1 1 0 0 1 1.414 1.414L11.828 12l3.879 3.879a1 1 0 0 1 0 1.828z"/></svg>`;
    indicator.title = '点击显示TTS面板';
    document.body.appendChild(indicator);

    if (edgeIndicatorLastTop) {
        indicator.style.top = edgeIndicatorLastTop;
        indicator.style.transform = 'none';
    }

    makeIndicatorDraggable(indicator);
}

function removeEdgeIndicator() {
    const indicator = document.getElementById('tts-edge-indicator');
    if (indicator) indicator.remove();
}

function makeIndicatorDraggable(indicator) {
    let isDragging = false;
    let hasDragged = false;
    let startY, startTop;

    const getClientY = (e) => e.touches ? e.touches[0].clientY : e.clientY;

    const dragStart = (e) => {
        e.stopPropagation();
        isDragging = true;
        hasDragged = false;
        startY = getClientY(e);
        startTop = indicator.getBoundingClientRect().top;
        indicator.style.transition = 'none';
        indicator.style.transform = 'none';
        indicator.style.top = `${startTop}px`;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', dragMove);
        document.addEventListener('mouseup', dragEnd);
        document.addEventListener('touchmove', dragMove, { passive: false });
        document.addEventListener('touchend', dragEnd);
    };

    const dragMove = (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const currentY = getClientY(e);
        const deltaY = currentY - startY;
        if (Math.abs(deltaY) > 3) hasDragged = true;

        let newTop = startTop + deltaY;
        const minTop = 50;
        const maxTop = window.innerHeight - indicator.offsetHeight - 50;
        newTop = Math.max(minTop, Math.min(maxTop, newTop));
        indicator.style.top = `${newTop}px`;
    };

    const dragEnd = (e) => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        indicator.style.transition = '';
        document.removeEventListener('mousemove', dragMove);
        document.removeEventListener('mouseup', dragEnd);
        document.removeEventListener('touchmove', dragMove);
        document.removeEventListener('touchend', dragEnd);

        edgeIndicatorLastTop = indicator.style.top;

        if (!hasDragged) {
            showPanel();
        }
    };

    indicator.addEventListener('mousedown', dragStart);
    indicator.addEventListener('touchstart', dragStart, { passive: false });
}

// 更新边缘模式
function updateEdgeMode() {
    const panel = document.getElementById('tts-floating-panel');
    if (!panel) return;
    if (edgeMode) {
        panel.classList.add('edge-mode');
    } else {
        panel.classList.remove('edge-mode');
    }
}

// 更新状态指示器
function updateStatusIndicator() {
    const statusDot = document.querySelector('.status-dot');
    if (!statusDot) return;
    if (isPlaying) {
        statusDot.classList.add('active');
    } else {
        statusDot.classList.remove('active');
    }
}

// ==================== 流式播放功能 ====================
let isStreamingMode = false;
let currentStreamingIndex = 0;
let streamingSegments = [];
let streamingAudioCache = new Map();

async function startStreamingPlayback(segments, options = {}) {
    if (isStreamingMode) stopStreamingPlayback();
    isStreamingMode = true;
    currentStreamingIndex = 0;
    streamingSegments = segments;
    streamingAudioCache.clear();
    console.log('开始流式播放模式，段落数:', segments.length);

    const preGenerateCount = Math.min(3, segments.length);
    for (let i = 0; i < preGenerateCount; i++) {
        if (segments[i]) {
            generateStreamingSegmentAudio(segments[i], i).catch(error => console.error(`预生成段落 ${i} 失败:`, error));
        }
    }
    return true;
}

function stopStreamingPlayback() {
    isStreamingMode = false;
    currentStreamingIndex = 0;
    streamingSegments = [];
    streamingAudioCache.forEach((audioData) => {
        if (audioData.blobUrl) URL.revokeObjectURL(audioData.blobUrl);
    });
    streamingAudioCache.clear();
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    console.log('流式播放模式已停止');
}

async function generateStreamingSegmentAudio(segment, index) {
    const cacheKey = `streaming_${index}_${segment.text.substring(0, 50)}`;
    if (streamingAudioCache.has(cacheKey)) return streamingAudioCache.get(cacheKey);

    try {
        const task = {
            dialogue: segment.text,
            character: segment.character || '',
            voice: segment.voice || defaultVoice,
            emotion: segment.emotion || emotion,
            speed: segment.speed || speedFacter
        };
        const audioResult = await generateSingleAudio(task);
        if (audioResult && audioResult.url) {
            const blobUrl = await fetchAudioBlob(audioResult.url);
            const cachedResult = { ...audioResult, blobUrl, segment, index, timestamp: Date.now() };
            streamingAudioCache.set(cacheKey, cachedResult);
            console.log(`流式段落 ${index} 音频生成完成`);
            return cachedResult;
        }
    } catch (error) {
        console.error(`生成流式段落 ${index} 音频失败:`, error);
        throw error;
    }
}

async function playStreamingSegment(segmentIndex) {
    if (!isStreamingMode || segmentIndex >= streamingSegments.length) return false;
    const segment = streamingSegments[segmentIndex];
    const cacheKey = `streaming_${segmentIndex}_${segment.text.substring(0, 50)}`;
    let audioData = streamingAudioCache.get(cacheKey);

    if (!audioData) {
        try { audioData = await generateStreamingSegmentAudio(segment, segmentIndex); }
        catch (error) { console.error(`播放流式段落 ${segmentIndex} 失败:`, error); return false; }
    }
    if (!audioData || !audioData.blobUrl) { console.warn(`流式段落 ${segmentIndex} 音频数据无效`); return false; }

    try {
        if (currentAudio) currentAudio.pause();
        await playAudio(audioData.blobUrl);
        console.log(`播放流式段落 ${segmentIndex}:`, segment.text.substring(0, 30) + '...');
        const nextIndex = segmentIndex + 1;
        if (nextIndex < streamingSegments.length) {
            generateStreamingSegmentAudio(streamingSegments[nextIndex], nextIndex).catch(error => console.error(`预生成下一段落失败:`, error));
        }
        return true;
    } catch (error) { console.error(`播放流式段落 ${segmentIndex} 失败:`, error); return false; }
}

function triggerStreamingPlayback(textProgress) {
    if (!isStreamingMode || streamingSegments.length === 0) return;
    const targetIndex = Math.floor(textProgress * streamingSegments.length);
    if (targetIndex > currentStreamingIndex && targetIndex < streamingSegments.length) {
        currentStreamingIndex = targetIndex;
        playStreamingSegment(targetIndex).catch(error => console.error('触发流式播放失败:', error));
    }
}

function getStreamingStatus() {
    return { isStreamingMode, currentIndex: currentStreamingIndex, totalSegments: streamingSegments.length, cachedSegments: streamingAudioCache.size };
}

// GAL流式播放管理器
const GalStreamingPlayer = {
    isActive: false,
    currentSegments: [],
    currentIndex: 0,
    audioCache: new Map(),
    typingProgress: 0,
    totalLength: 0,
    config: { segmentDelay: 500, preloadCount: 2, syncThreshold: 0.1, enableDebug: false },

    async initialize(galDialogues) {
        if (!galDialogues || galDialogues.length === 0) { console.warn('GAL流式播放：没有对话数据'); return false; }
        this.isActive = true;
        this.currentSegments = galDialogues;
        this.currentIndex = 0;
        this.audioCache.clear();
        this.typingProgress = 0;
        this.totalLength = galDialogues.reduce((sum, dialogue) => sum + (dialogue.content ? dialogue.content.length : 0), 0);
        if (this.config.enableDebug) console.log('GAL流式播放初始化:', { segments: galDialogues.length, totalLength: this.totalLength });
        await this.preloadSegments(0, Math.min(this.config.preloadCount, galDialogues.length));
        return true;
    },

    async preloadSegments(startIndex, count) {
        const promises = [];
        for (let i = startIndex; i < Math.min(startIndex + count, this.currentSegments.length); i++) {
            const segment = this.currentSegments[i];
            if (segment && segment.content && !this.audioCache.has(i)) promises.push(this.generateSegmentAudio(segment, i));
        }
        try { await Promise.all(promises); if (this.config.enableDebug) console.log(`预加载完成: ${startIndex} - ${startIndex + count - 1}`); }
        catch (error) { console.error('预加载音频失败:', error); }
    },

    async generateSegmentAudio(segment, index) {
        if (!segment.content || this.audioCache.has(index)) return;
        try {
            const task = { dialogue: segment.content, character: segment.character || '', voice: this.getVoiceForCharacter(segment.character), emotion: segment.emotion || emotion, speed: speedFacter };
            const audioResult = await generateSingleAudio(task);
            if (audioResult && audioResult.url) {
                const blobUrl = await fetchAudioBlob(audioResult.url);
                this.audioCache.set(index, { ...audioResult, blobUrl, segment, timestamp: Date.now() });
                if (this.config.enableDebug) console.log(`段落 ${index} 音频生成完成`);
            }
        } catch (error) { console.error(`生成段落 ${index} 音频失败:`, error); }
    },

    getVoiceForCharacter(character) {
        if (!character) return defaultVoice;
        if (characterVoices[character]) {
            const vs = characterVoices[character];
            return typeof vs === 'object' ? vs.voice : vs;
        }
        for (const [groupName, groupData] of Object.entries(characterGroups)) {
            if (groupData.characters && groupData.characters.includes(character)) return groupData.voice || defaultVoice;
        }
        return defaultVoice;
    },

    updateProgress(progress, currentLength) {
        if (!this.isActive || this.currentSegments.length === 0) return;
        this.typingProgress = progress;
        const targetIndex = Math.floor(progress * this.currentSegments.length);
        if (targetIndex > this.currentIndex && targetIndex < this.currentSegments.length) this.playSegment(targetIndex);
    },

    async playSegment(index) {
        if (index >= this.currentSegments.length || index < 0) return;
        let cachedAudio = this.audioCache.get(index);
        if (!cachedAudio) {
            await this.generateSegmentAudio(this.currentSegments[index], index);
            cachedAudio = this.audioCache.get(index);
            if (!cachedAudio) { console.warn(`段落 ${index} 音频生成失败`); return; }
        }
        if (!cachedAudio.blobUrl) return;
        try {
            if (currentAudio) currentAudio.pause();
            await playAudio(cachedAudio.blobUrl);
            this.currentIndex = index;
            if (this.config.enableDebug) console.log(`播放段落 ${index}`);
            if (index + 1 < this.currentSegments.length) this.preloadSegments(index + 1, this.config.preloadCount);
        } catch (error) { console.error(`播放段落 ${index} 失败:`, error); }
    },

    stop() {
        this.isActive = false;
        this.currentIndex = 0;
        this.typingProgress = 0;
        this.audioCache.forEach((audioData) => { if (audioData.blobUrl) URL.revokeObjectURL(audioData.blobUrl); });
        this.audioCache.clear();
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        if (this.config.enableDebug) console.log('GAL流式播放已停止');
    },

    resetToPage(pageIndex) {
        this.currentIndex = 0;
        this.typingProgress = 0;
        if (currentAudio) { currentAudio.pause(); currentAudio = null; }
        if (this.config.enableDebug) console.log(`GAL流式播放重置到页面 ${pageIndex}`);
    },

    getStatus() {
        return { isActive: this.isActive, currentIndex: this.currentIndex, totalSegments: this.currentSegments.length, cachedSegments: this.audioCache.size, typingProgress: this.typingProgress, config: { ...this.config } };
    },

    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        if (this.config.enableDebug) console.log('GAL流式播放配置已更新:', this.config);
    }
};

// ==================== 流式播放功能结束 ====================

// ========== 前端美化适配功能 ==========
function extractTextFromElementAdapted(element) {
    if (!element) return '';
    const debugMode = false;
    if (debugMode) console.log('开始检测元素:', element);

    const iframes = element.querySelectorAll('iframe');
    if (iframes.length > 0) {
        if (debugMode) console.log(`发现 ${iframes.length} 个iframe`);
        let iframeText = '';

        for (const iframe of iframes) {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (iframeDoc && iframeDoc.body) {
                    if (debugMode) console.log('成功访问iframe文档');
                    const extractedText = extractFromJuusStructure(iframeDoc);
                    if (extractedText) iframeText += extractedText;

                    if (!iframeText) {
                        const narrativeElements = iframeDoc.querySelectorAll('.narrative-text');
                        if (narrativeElements.length > 0) {
                            narrativeElements.forEach(elem => {
                                const text = elem.innerText || elem.textContent;
                                if (text && text.trim()) iframeText += text.trim() + '\n';
                            });
                        }
                        if (!iframeText) {
                            const bodyText = iframeDoc.body.innerText || iframeDoc.body.textContent;
                            if (bodyText && bodyText.trim()) {
                                const cleanText = bodyText.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '').trim();
                                if (cleanText) iframeText += cleanText + '\n';
                            }
                        }
                    }
                }
            } catch (error) {
                if (debugMode) console.warn('无法访问iframe内容:', error);
                if (iframe.hasAttribute('srcdoc')) {
                    const srcdoc = iframe.getAttribute('srcdoc');
                    if (srcdoc) {
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = srcdoc;
                        const extractedText = extractFromJuusStructure(tempDiv);
                        if (extractedText) iframeText += extractedText;
                        if (!iframeText) {
                            const allText = tempDiv.innerText || tempDiv.textContent;
                            if (allText && allText.trim()) iframeText += allText.trim() + '\n';
                        }
                    }
                }
            }
        }
        if (iframeText.trim()) return iframeText.trim();
    }

    const summaryElements = element.querySelectorAll('details summary');
    summaryElements.forEach(summary => summary.style.display = 'none');
    let text = '';
    if (element.innerText && element.innerText.trim()) text = element.innerText.trim();
    else if (element.textContent && element.textContent.trim()) text = element.textContent.trim();
    summaryElements.forEach(summary => summary.style.display = '');
    return text.replace(/\s+/g, ' ').trim();
}

function extractFromJuusStructure(doc) {
    const dialoguePages = doc.querySelectorAll('.dialogue-page');
    if (dialoguePages.length === 0) return '';

    let fullText = '';
    dialoguePages.forEach((page) => {
        const dialogueWrappers = page.querySelectorAll('.dialogue-wrapper');
        dialogueWrappers.forEach(wrapper => {
            const metaDiv = wrapper.querySelector('.dialogue-meta');
            let character = '', charEmotion = '';
            if (metaDiv) {
                const charSpan = metaDiv.querySelector('.dialogue-char');
                const emoSpan = metaDiv.querySelector('.dialogue-emo');
                if (charSpan) character = charSpan.textContent.replace(/【|】/g, '').trim();
                if (emoSpan) charEmotion = emoSpan.textContent.replace(/〈|〉/g, '').trim();
            }
            const dialogueDiv = wrapper.querySelector('.dialogue-text');
            if (dialogueDiv) {
                const dialogueText = dialogueDiv.dataset.fullText || dialogueDiv.textContent || '';
                if (dialogueText.trim()) {
                    const isQuotedDialogue = dialogueDiv.classList.contains('dialogue-quote');
                    if (character) {
                        if (charEmotion) fullText += `【${character}】〈${charEmotion}〉「${dialogueText.trim()}」\n`;
                        else fullText += `【${character}】「${dialogueText.trim()}」\n`;
                    } else if (isQuotedDialogue) fullText += `「${dialogueText.trim()}」\n`;
                    else fullText += `${dialogueText.trim()}\n`;
                }
            }
        });

        const textDivs = page.querySelectorAll('.dialogue-text:not(.dialogue-quote)');
        textDivs.forEach(textDiv => {
            if (!textDiv.closest('.dialogue-wrapper')) {
                const text = textDiv.dataset.fullText || textDiv.textContent || '';
                if (text.trim()) fullText += `${text.trim()}\n`;
            }
        });
    });

    const statusBlock = doc.querySelector('.status-modal');
    if (statusBlock && statusBlock.style.display !== 'none') {
        const statusText = statusBlock.innerText || statusBlock.textContent || '';
        if (statusText.trim()) fullText += `<statusblock>\n${statusText.trim()}\n</statusblock>\n`;
    }

    const optionsModal = doc.querySelector('.options-modal');
    if (optionsModal && optionsModal.style.display !== 'none') {
        const optionButtons = optionsModal.querySelectorAll('.dialogue-option');
        if (optionButtons.length > 0) {
            fullText += '<choice>\n';
            optionButtons.forEach(button => {
                const optionText = button.textContent || '';
                if (optionText.trim()) fullText += `[${optionText.trim()}]\n`;
            });
            fullText += '</choice>\n';
        }
    }
    return fullText.trim();
}

async function waitForIframesLoadAdapted(element) {
    return new Promise((resolve) => {
        const iframes = element.querySelectorAll('iframe');
        if (iframes.length === 0) { resolve(); return; }
        console.log(`等待 ${iframes.length} 个iframe加载...`);
        let loadedCount = 0;
        const checkAllLoaded = () => { loadedCount++; if (loadedCount >= iframes.length) resolve(); };

        iframes.forEach((iframe) => {
            if (iframe.hasAttribute('srcdoc')) {
                setTimeout(checkAllLoaded, 500);
            } else if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
                checkAllLoaded();
            } else {
                iframe.addEventListener('load', checkAllLoaded);
                setTimeout(checkAllLoaded, 2000);
            }
        });
    });
}

async function forceDetectCurrentMessageAdapted() {
    const messages = document.querySelectorAll('div.mes[is_user="false"]');
    if (messages.length === 0) return { success: false, message: '没有找到AI消息' };

    const lastMessageElement = messages[messages.length - 1];
    const messageTextElement = lastMessageElement.querySelector('.mes_text');
    if (!messageTextElement) return { success: false, message: '消息元素不存在' };

    await waitForIframesLoadAdapted(messageTextElement);
    await new Promise(resolve => setTimeout(resolve, 1000));

    const fullText = extractTextFromElementAdapted(messageTextElement);
    console.log('提取到的完整文本长度:', fullText.length);

    if (!fullText) return { success: false, message: '消息文本为空' };
    return processMessageText(fullText, lastMessageElement);
}

function processMessageText(fullText, messageElement) {
    const currentMessageParts = [];
    let hasNewCharacter = false;
    let newCharacterCount = 0;
    let actualDialogueCount = 0;
    const validDialogueRegex = /[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff]/;

    console.log('开始处理文本，当前模式:', detectionMode);

    if (detectionMode === 'character_and_dialogue') {
        const regex = /【([^】]+)】\s*「([^」]+?)」/gs;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const character = match[1].trim();
            const dialogue = match[2].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) {
                currentMessageParts.push({ type: 'character_dialogue', character, dialogue });
                actualDialogueCount++;
                if (character && !allDetectedCharacters.has(character)) {
                    allDetectedCharacters.add(character);
                    characterVoices[character] = DO_NOT_PLAY_VALUE;
                    hasNewCharacter = true;
                    newCharacterCount++;
                }
            }
        }
    } else if (detectionMode === 'character_emotion_and_dialogue') {
        const regex = /【([^】]+)】\s*〈([^〉]+)〉\s*「([^」]+?)」/gs;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const character = match[1].trim();
            const charEmotion = match[2].trim();
            const dialogue = match[3].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) {
                currentMessageParts.push({ type: 'character_emotion_dialogue', character, emotion: charEmotion, dialogue });
                actualDialogueCount++;
                if (character && !allDetectedCharacters.has(character)) {
                    allDetectedCharacters.add(character);
                    characterVoices[character] = DO_NOT_PLAY_VALUE;
                    hasNewCharacter = true;
                    newCharacterCount++;
                }
            }
        }
    } else if (detectionMode === 'emotion_and_dialogue') {
        const regex = /〈([^〉]+)〉\s*「([^」]+?)」/gs;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const charEmotion = match[1].trim();
            const dialogue = match[2].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) {
                currentMessageParts.push({ type: 'emotion_dialogue', emotion: charEmotion, dialogue });
                actualDialogueCount++;
            }
        }
    } else if (detectionMode === 'narration_and_dialogue') {
        const segments = fullText.split(getDialogueSplitRegex());
        for (const segment of segments) {
            const trimmedSegment = segment.trim();
            if (!trimmedSegment) continue;
            if (isDialogueFormat(trimmedSegment)) {
                const dialogue = extractDialogue(trimmedSegment);
                if (dialogue && validDialogueRegex.test(dialogue)) {
                    currentMessageParts.push({ type: 'dialogue', dialogue });
                    actualDialogueCount++;
                }
            } else {
                if (validDialogueRegex.test(trimmedSegment)) {
                    currentMessageParts.push({ type: 'narration', dialogue: trimmedSegment });
                }
            }
        }
    } else if (detectionMode === 'dialogue_only') {
        const regex = getDialogueRegex();
        const allDialogues = [];
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const dialogue = match[1].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) {
                allDialogues.push(dialogue);
                actualDialogueCount++;
            }
        }
        if (allDialogues.length > 0) currentMessageParts.push({ type: 'dialogue_only', dialogue: allDialogues.join('\n') });
    } else if (detectionMode === 'entire_message') {
        const trimmedText = fullText.trim();
        if (trimmedText) {
            currentMessageParts.push({ type: 'entire_message', dialogue: trimmedText });
            actualDialogueCount = 1;
        }
    }

    console.log(`处理完成，共检测到 ${currentMessageParts.length} 个片段`);

    if (hasNewCharacter) saveSettings();
    lastMessageParts = currentMessageParts;

    const messageId = messageElement.getAttribute('mesid') || messageElement.textContent.substring(0, 50) || Date.now().toString();
    lastProcessedMessageId = messageId;

    return { success: true, totalParts: currentMessageParts.length, characterCount: newCharacterCount, detectedText: fullText.substring(0, 100), actualDialogueCount, hasNewCharacter };
}

// ========== 前端美化适配功能结束 ==========

// ========== 角色管理功能 ==========
async function getModelsForVersion(version) {
    const versionModels = ttsModelsWithDetails[version];
    if (versionModels && Array.isArray(versionModels)) return versionModels;
    return ttsModels || [];
}

function showSingleCharacterSelector(button) {
    const existingPanel = document.getElementById('tts-single-char-panel');
    if (existingPanel) { existingPanel.remove(); return; }

    const panel = $(`
        <div id="tts-single-char-panel" style="position:fixed;background:white;border:2px solid #667eea;border-radius:12px;padding:15px;box-shadow:0 8px 24px rgba(0,0,0,0.2);z-index:10001;max-height:400px;overflow-y:auto;min-width:200px;"></div>
    `);

    const rect = button.getBoundingClientRect();
    panel.css({ left: rect.left + 'px', top: (rect.bottom + 5) + 'px' });

    panel.append(`<div style="font-weight:600;color:#667eea;margin-bottom:10px;font-size:14px;">选择角色</div>`);

    // 全部角色选项
    const allOption = $(`<div class="single-char-option" style="padding:8px 12px;margin:4px 0;border-radius:6px;cursor:pointer;background:${!singleCharacterTarget ? 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)' : '#f8f9fa'};color:${!singleCharacterTarget ? 'white' : '#495057'};font-size:13px;">» 全部角色 «</div>`);
    allOption.on('click', () => {
        singleCharacterTarget = '';
        saveSettings();
        lastMessageParts = [];
        lastProcessedMessageId = null;
        reparseCurrentMessage();
        showNotification('已切换到全部角色', 'info');
        $('#tts-single-char-select-btn').html(`<i class="icon">👤</i><span class="text">全部角色</span>`);
        panel.remove();
    });
    panel.append(allOption);
    panel.append(`<div style="height:1px;background:#dee2e6;margin:8px 0;"></div>`);

    const characters = Array.from(allDetectedCharacters).sort();
    if (characters.length === 0) {
        panel.append(`<div style="padding:20px;text-align:center;color:#6c757d;font-size:12px;">暂无检测到的角色</div>`);
    } else {
        characters.forEach(char => {
            const charOption = $(`<div class="single-char-option" style="padding:8px 12px;margin:4px 0;border-radius:6px;cursor:pointer;background:${singleCharacterTarget === char ? 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)' : '#f8f9fa'};color:${singleCharacterTarget === char ? 'white' : '#495057'};font-size:13px;">${char}</div>`);
            charOption.on('click', () => {
                singleCharacterTarget = char;
                saveSettings();
                lastMessageParts = [];
                lastProcessedMessageId = null;
                reparseCurrentMessage();
                showNotification(`已选择角色：${char}`, 'success');
                $('#tts-single-char-select-btn').html(`<i class="icon">👤</i><span class="text">${char}</span>`);
                panel.remove();
            });
            panel.append(charOption);
        });
    }

    $('body').append(panel);
    setTimeout(() => {
        $(document).on('click.singleCharPanel', function (e) {
            if (!panel.is(e.target) && panel.has(e.target).length === 0 && e.target !== button) {
                panel.remove();
                $(document).off('click.singleCharPanel');
            }
        });
    }, 100);
}

function updateSingleCharacterSelector() {
    const container = document.getElementById('tts-single-char-container');
    const btn = document.getElementById('tts-single-char-select-btn');
    if (!container || !btn) return;
    const shouldShow = isSingleCharacterMode && (detectionMode === 'character_and_dialogue' || detectionMode === 'character_emotion_and_dialogue');
    container.style.display = shouldShow ? 'block' : 'none';
    btn.innerHTML = `<i class="icon">👤</i><span class="text">${singleCharacterTarget || '全部角色'}</span>`;
}

async function renderCharacterGroups() {
    const container = document.getElementById('character-groups-container');
    if (!container) return;

    const groupNames = Object.keys(characterGroups);
    if (groupNames.length === 0) {
        container.innerHTML = '<p class="tts-empty-state">暂无分组，请先创建分组</p>';
        return;
    }

    container.innerHTML = '';
    for (const groupName of groupNames) {
        const group = characterGroups[groupName];
        const groupDiv = document.createElement('div');
        groupDiv.className = 'tts-group-item';

        const assignedCharacters = new Set();
        Object.values(characterGroups).forEach(g => { if (g.characters) g.characters.forEach(char => assignedCharacters.add(char)); });
        const unassignedCharacters = Array.from(allDetectedCharacters).filter(char => !assignedCharacters.has(char) || (group.characters && group.characters.includes(char)));

        let charactersHtml = '';
        if (group.characters && group.characters.length > 0) {
            for (const char of group.characters) {
                const voiceSetting = characterVoices[char];
                const voice = typeof voiceSetting === 'object' ? voiceSetting.voice || '' : voiceSetting || '';
                const version = typeof voiceSetting === 'object' ? voiceSetting.version || ttsApiVersion : ttsApiVersion;
                const speed = typeof voiceSetting === 'object' ? voiceSetting.speed || 1.0 : 1.0;
                const modelsForVersion = await getModelsForVersion(version);

                charactersHtml += `
                    <div class="tts-group-character">
                        <div class="tts-character-info">
                            <span class="character-name">${char}</span>
                            <div class="tts-character-controls-group">
                                <select class="tts-character-version-in-group" data-char="${char}">
                                    ${['v2', 'v2Pro', 'v2ProPlus', 'v3', 'v4'].map(v => `<option value="${v}" ${version === v ? 'selected' : ''}>${v}</option>`).join('')}
                                </select>
                                <select class="tts-character-voice-in-group" data-char="${char}">
                                    <option value="">» 使用默认 «</option>
                                    <option value="${DO_NOT_PLAY_VALUE}" ${voice === DO_NOT_PLAY_VALUE ? 'selected' : ''}>🔇 不播放</option>
                                    ${modelsForVersion.map(model => `<option value="${model}" ${voice === model ? 'selected' : ''}>${model}</option>`).join('')}
                                </select>
                                <div class="tts-character-speed-control">
                                    <label>语速: <span class="tts-character-speed-value-in-group" data-char="${char}">${speed}</span></label>
                                    <input type="range" class="tts-character-speed-slider-in-group" data-char="${char}" min="0.5" max="2.0" step="0.01" value="${speed}">
                                </div>
                            </div>
                        </div>
                        <button class="tts-remove-from-group" data-group="${groupName}" data-char="${char}">移除</button>
                    </div>
                `;
            }
        } else {
            charactersHtml = '<p class="tts-empty-state">暂无角色</p>';
        }

        groupDiv.innerHTML = `
            <div class="tts-group-header" style="border-left:4px solid ${group.color || '#667eea'}" data-group="${groupName}">
                <div class="tts-group-info">
                    <span class="tts-group-name"><span class="tts-collapse-icon">▶</span>${groupName}</span>
                    <span class="tts-group-count">${group.characters ? group.characters.length : 0} 个角色</span>
                </div>
                <button class="tts-delete-group" data-group="${groupName}">删除分组</button>
            </div>
            <div class="tts-group-content" style="display:none;">
                <div class="tts-group-characters">${charactersHtml}</div>
                ${unassignedCharacters.length > 0 ? `
                    <div class="tts-add-character">
                        <select class="tts-character-select" data-group="${groupName}">
                            <option value="">选择要添加的角色</option>
                            ${unassignedCharacters.map(char => `<option value="${char}">${char}</option>`).join('')}
                        </select>
                        <button class="tts-add-to-group" data-group="${groupName}">添加角色</button>
                    </div>
                ` : ''}
            </div>
        `;
        container.appendChild(groupDiv);
    }
    bindGroupManagementEvents();
}

function bindGroupManagementEvents() {
    const container = document.getElementById('character-groups-container');
    if (!container) return;

    // 折叠展开
    container.querySelectorAll('.tts-group-header').forEach(header => {
        header.addEventListener('click', (e) => {
            if (e.target.closest('.tts-delete-group')) return;
            const content = header.nextElementSibling;
            const icon = header.querySelector('.tts-collapse-icon');
            if (content.style.display === 'none') { content.style.display = 'block'; icon.textContent = '▼'; }
            else { content.style.display = 'none'; icon.textContent = '▶'; }
        });
    });

    // 版本切换
    container.querySelectorAll('.tts-character-version-in-group').forEach(select => {
        select.addEventListener('change', async (e) => {
            const char = e.target.dataset.char;
            const newVersion = e.target.value;
            const voiceSelect = e.target.closest('.tts-character-controls-group').querySelector('.tts-character-voice-in-group');
            const models = await getModelsForVersion(newVersion);
            voiceSelect.innerHTML = `<option value="">» 使用默认 «</option><option value="${DO_NOT_PLAY_VALUE}">🔇 不播放</option>${models.map(m => `<option value="${m}">${m}</option>`).join('')}`;
        });
    });

    // 语音选择
    container.querySelectorAll('.tts-character-voice-in-group').forEach(select => {
        select.addEventListener('change', (e) => {
            const char = e.target.dataset.char;
            const voice = e.target.value;
            const version = e.target.closest('.tts-character-controls-group').querySelector('.tts-character-version-in-group').value;
            if (voice) characterVoices[char] = { voice, version, speed: characterVoices[char]?.speed || 1.0 };
            else delete characterVoices[char];
            saveSettings();
        });
    });

    // 语速
    container.querySelectorAll('.tts-character-speed-slider-in-group').forEach(slider => {
        const char = slider.dataset.char;
        const speedValue = container.querySelector(`.tts-character-speed-value-in-group[data-char="${char}"]`);
        slider.addEventListener('input', (e) => { speedValue.textContent = e.target.value; });
        slider.addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value);
            if (characterVoices[char]) characterVoices[char].speed = speed;
            else characterVoices[char] = { voice: '', version: ttsApiVersion, speed };
            saveSettings();
        });
    });

    // 删除分组
    container.querySelectorAll('.tts-delete-group').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const groupName = e.target.dataset.group;
            if (confirm(`确定要删除分组 "${groupName}" 吗？`)) {
                delete characterGroups[groupName];
                saveSettings();
                renderCharacterGroups();
                showNotification(`分组 "${groupName}" 已删除`, 'success');
            }
        });
    });

    // 从分组移除
    container.querySelectorAll('.tts-remove-from-group').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const groupName = e.target.dataset.group;
            const charName = e.target.dataset.char;
            if (characterGroups[groupName]?.characters) {
                characterGroups[groupName].characters = characterGroups[groupName].characters.filter(c => c !== charName);
                saveSettings();
                renderCharacterGroups();
                showNotification(`已将 "${charName}" 从分组移除`, 'success');
            }
        });
    });

    // 添加到分组
    container.querySelectorAll('.tts-add-to-group').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const groupName = e.target.dataset.group;
            const select = container.querySelector(`.tts-character-select[data-group="${groupName}"]`);
            const charName = select.value;
            if (!charName) { showNotification('请选择要添加的角色', 'warning'); return; }
            const group = characterGroups[groupName];
            if (group) {
                if (!group.characters) group.characters = [];
                Object.keys(characterGroups).forEach(other => {
                    if (other !== groupName && characterGroups[other].characters)
                        characterGroups[other].characters = characterGroups[other].characters.filter(c => c !== charName);
                });
                if (!group.characters.includes(charName)) group.characters.push(charName);
                saveSettings();
                renderCharacterGroups();
                showNotification(`已将 "${charName}" 添加到分组 "${groupName}"`, 'success');
            }
        });
    });
}

// ========== 角色管理功能结束 ==========

// ========== 网络诊断与检测功能 ==========
async function testConnection() {
    try {
        console.log("开始测试TTS服务连接...");
        showNotification("正在测试连接...", 'info');
        const response = await makeRequest(`${ttsApiBaseUrl}/`, { method: "GET", timeout: 5000 });
        console.log("连接测试结果:", response.status);
        if (response.status === 200) {
            showNotification("TTS服务连接正常！", 'success');
        } else {
            showNotification(`TTS服务连接异常: ${response.status}`, 'error');
        }
    } catch (error) {
        console.error("连接测试失败:", error);
        showNotification(`无法连接到TTS服务: ${error.message}`, 'error');
    }
}

async function runDiagnostic() {
    const diagnosticResults = [];
    showNotification("开始网络诊断...", 'info');

    // 测试API基础地址
    try {
        const response = await fetch(`${ttsApiBaseUrl}/`, { method: 'GET', signal: AbortSignal.timeout(5000) });
        diagnosticResults.push({ test: 'API基础地址', status: response.ok ? 'success' : 'warning', detail: `状态码: ${response.status}` });
    } catch (e) {
        diagnosticResults.push({ test: 'API基础地址', status: 'error', detail: e.message });
    }

    // 测试模型接口
    try {
        const response = await fetch(`${TTS_API_ENDPOINT_MODELS}`, { method: 'GET', signal: AbortSignal.timeout(5000) });
        diagnosticResults.push({ test: '模型列表接口', status: response.ok ? 'success' : 'warning', detail: `状态码: ${response.status}` });
    } catch (e) {
        diagnosticResults.push({ test: '模型列表接口', status: 'error', detail: e.message });
    }

    // 显示诊断结果
    const resultHtml = diagnosticResults.map(r => `<div class="diagnostic-item ${r.status}"><strong>${r.test}:</strong> ${r.detail}</div>`).join('');
    const modal = $(`
        <div class="tts-modal" id="diagnostic-modal">
            <div class="tts-modal-content" style="max-width:600px;">
                <div class="tts-modal-header"><h2><i class="icon">🔧</i> 网络诊断结果</h2><button class="tts-close-btn">×</button></div>
                <div class="tts-modal-body">${resultHtml}</div>
            </div>
        </div>
    `);
    $('body').append(modal);
    modal.find('.tts-close-btn').on('click', () => modal.remove());
    modal.on('click', e => { if (e.target === modal[0]) modal.remove(); });
    showNotification("诊断完成，请查看结果", 'success');
}

function createDetectionInfoPopup(detectionLogs) {
    const logsHtml = detectionLogs.map(log => {
        if (log.includes('提取到的完整文本长度:')) return `<div class="tts-detection-log-item" style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;font-weight:bold;padding:8px 12px;border-radius:6px;margin-bottom:8px;"><strong>${log}</strong></div>`;
        if (log.includes('开始处理文本')) return `<div class="tts-detection-log-item" style="background:#e3f2fd;color:#1976d2;border-left:4px solid #2196f3;padding:8px 12px;border-radius:6px;margin-bottom:8px;"><strong>${log}</strong></div>`;
        if (log.includes('检测到角色对话:')) return `<div class="tts-detection-log-item" style="background:#e8f5e8;color:#2e7d32;border-left:4px solid #4caf50;padding:8px 12px;border-radius:6px;margin-bottom:8px;">${log}</div>`;
        if (log.includes('检测到旁白:')) return `<div class="tts-detection-log-item" style="background:#fce4ec;color:#c2185b;border-left:4px solid #e91e63;padding:8px 12px;border-radius:6px;margin-bottom:8px;">${log}</div>`;
        return `<div class="tts-detection-log-item" style="background:#f5f5f5;color:#424242;border-left:4px solid #9e9e9e;padding:8px 12px;border-radius:6px;margin-bottom:8px;">${log}</div>`;
    }).join('');

    const modal = $(`
        <div class="tts-modal" id="tts-detection-info-modal" style="z-index:10001;">
            <div class="tts-modal-content" style="max-width:800px;max-height:600px;">
                <div class="tts-modal-header"><h2><i class="icon">🔍</i> 检测信息详情</h2><button class="tts-close-btn">×</button></div>
                <div class="tts-modal-body" style="max-height:500px;overflow-y:auto;">${logsHtml}</div>
            </div>
        </div>
    `);
    $('body').append(modal);
    modal.find('.tts-close-btn').on('click', () => modal.remove());
    modal.on('click', e => { if (e.target === modal[0]) modal.remove(); });
    return modal;
}

async function handleFrontendDetectClick() {
    if (isPlaying) { showNotification("正在播放中，请先停止。", 'info'); return; }

    try {
        showNotification("正在使用前端适配模式检测...", 'info');
        const originalLog = console.log;
        const detectionLogs = [];
        console.log = function (...args) {
            const message = args.join(' ');
            if (message.includes('提取到的完整文本长度:') || message.includes('开始处理文本') ||
                message.includes('检测到纯对话:') || message.includes('检测到角色对话:') ||
                message.includes('检测到角色情绪对话:') || message.includes('检测到情绪对话:') ||
                message.includes('检测到对话:') || message.includes('检测到旁白:')) {
                detectionLogs.push(message);
            }
            originalLog.apply(console, args);
        };

        const result = await forceDetectCurrentMessageAdapted();
        console.log = originalLog;

        if (result.success) {
            showNotification(`前端适配检测成功！检测到 ${result.totalParts} 个语音片段。`, 'success');
            createDetectionInfoPopup(detectionLogs);
            const playButton = document.getElementById('tts-play-btn');
            if (playButton) playButton.disabled = result.totalParts === 0;
        } else {
            showNotification(`前端适配检测失败：${result.message}`, 'error');
        }
    } catch (error) {
        console.error('前端适配检测错误:', error);
        showNotification(`前端适配检测出错：${error.message}`, 'error');
    }
}

function handleReinferClick() {
    if (isPlaying) { showNotification("正在播放中，请先停止。", 'info'); return; }
    if (lastMessageParts.length === 0) { showNotification("没有可重新推理的内容。", 'warning'); return; }
    if (ttsModels.length === 0) { showNotification("无法连接到TTS服务或未找到语音模型。", 'error'); return; }

    const tasksToGenerate = lastMessageParts.map(part => {
        let voice = '', version = ttsApiVersion, taskEmotion = null, voiceSetting;
        switch (part.type) {
            case 'character_emotion_dialogue':
                voiceSetting = characterVoices[part.character];
                voice = typeof voiceSetting === 'object' ? voiceSetting.voice || defaultVoice : voiceSetting || defaultVoice;
                version = typeof voiceSetting === 'object' ? voiceSetting.version || ttsApiVersion : ttsApiVersion;
                taskEmotion = part.emotion;
                break;
            case 'emotion_dialogue': voice = dialogueVoice || defaultVoice; taskEmotion = part.emotion; break;
            case 'character_dialogue':
                voiceSetting = characterVoices[part.character];
                voice = typeof voiceSetting === 'object' ? voiceSetting.voice || defaultVoice : voiceSetting || defaultVoice;
                version = typeof voiceSetting === 'object' ? voiceSetting.version || ttsApiVersion : ttsApiVersion;
                break;
            case 'narration': voice = narrationVoice || defaultVoice; break;
            case 'dialogue': voice = dialogueVoice || defaultVoice; break;
            case 'dialogue_only': case 'entire_message': voice = defaultVoice; break;
        }
        if (voice && voice !== DO_NOT_PLAY_VALUE) return { dialogue: part.dialogue, voice, version, emotion: taskEmotion, character: part.character, bypassCache: true };
        return null;
    }).filter(Boolean);

    if (tasksToGenerate.length === 0) { showNotification("没有需要播放的对话内容。", 'warning'); return; }

    isPlaying = true;
    isPaused = false;
    generationQueue = [...tasksToGenerate];
    playbackQueue = [];
    currentPlaybackIndex = 0;
    processGenerationQueue();
}

// ========== 网络诊断与检测功能结束 ==========

// 更新API端点
function updateApiEndpoints() {
    TTS_API_ENDPOINT_INFER = `${ttsApiBaseUrl}/infer_single`;
    TTS_API_ENDPOINT_MODELS = `${ttsApiBaseUrl}/models`;
}

// 加载设置
function loadSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }

    const settings = extension_settings[extensionName];
    for (const key in defaultSettings) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }

    ttsApiBaseUrl = settings.ttsApiBaseUrl;
    updateApiEndpoints();
    ttsApiVersion = settings.ttsApiVersion;
    detectionMode = settings.detectionMode;
    speedFacter = settings.speedFacter;
    emotion = settings.emotion;
    narrationVoice = settings.narrationVoice;
    dialogueVoice = settings.dialogueVoice;
    characterVoices = settings.characterVoices || {};
    defaultVoice = settings.defaultVoice;
    allDetectedCharacters = new Set(settings.allDetectedCharacters || []);
    characterGroups = settings.characterGroups || {};
    maxConcurrentGenerations = settings.maxConcurrentGenerations;
    preloadEnabled = settings.preloadEnabled;
    autoPlayEnabled = settings.autoPlayEnabled;
    quotationStyle = settings.quotationStyle;
    frontendAdaptationEnabled = settings.frontendAdaptationEnabled;
    isSingleCharacterMode = settings.isSingleCharacterMode;
    singleCharacterTarget = settings.singleCharacterTarget;
}

// 保存设置
function saveSettings() {
    extension_settings[extensionName] = {
        ttsApiBaseUrl,
        ttsApiVersion,
        detectionMode,
        speedFacter,
        emotion,
        narrationVoice,
        dialogueVoice,
        characterVoices,
        defaultVoice,
        allDetectedCharacters: Array.from(allDetectedCharacters),
        characterGroups,
        maxConcurrentGenerations,
        preloadEnabled,
        autoPlayEnabled,
        quotationStyle,
        frontendAdaptationEnabled,
        isSingleCharacterMode,
        singleCharacterTarget
    };
    saveSettingsDebounced();
}

// 网络请求
async function makeRequest(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 10000);

    try {
        const response = await fetch(url, {
            method: options.method || "GET",
            headers: options.headers || {},
            body: options.data || options.body,
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        const text = await response.text();
        return { status: response.status, statusText: response.statusText, responseText: text, ok: response.ok };
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

// 获取音频Blob
async function fetchAudioBlob(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const blob = await response.blob();
    return URL.createObjectURL(blob);
}

// 检测语言
function detectLanguage(text) {
    const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
    return japaneseRegex.test(text) ? "日语" : "中文";
}

// 引号相关函数
function getDialogueRegex() {
    return quotationStyle === 'western' ? /"([^"]+?)"/g : /「([^」]+?)」/g;
}

function getDialogueSplitRegex() {
    return quotationStyle === 'western' ? /("[^"]*")/g : /(「[^」]*」)/g;
}

function isDialogueFormat(text) {
    if (quotationStyle === 'western') {
        return text.startsWith('"') && text.endsWith('"');
    }
    return text.startsWith('「') && text.endsWith('」');
}

function extractDialogue(text) {
    const trimmed = text.trim();
    if (quotationStyle === 'western') {
        return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).trim() : trimmed;
    }
    return trimmed.startsWith('「') && trimmed.endsWith('」') ? trimmed.slice(1, -1).trim() : trimmed;
}

// 缓存管理
function generateCacheKey(text, voice, params) {
    return `${voice}_${text}_${JSON.stringify(params)}`;
}

function cleanupCache() {
    if (audioCache.size > 50) {
        const keys = Array.from(audioCache.keys()).slice(0, audioCache.size - 30);
        keys.forEach(key => {
            const cached = audioCache.get(key);
            if (cached && cached.blobUrl) URL.revokeObjectURL(cached.blobUrl);
            audioCache.delete(key);
        });
    }
}

// 生成音频
async function generateSingleAudio(task) {
    let currentEmotion = task.emotion || emotion;
    let currentSpeed = speedFacter;

    const modelDetails = ttsModelsWithDetails[task.voice];
    if (currentEmotion !== '默认' && modelDetails) {
        const lang = detectLanguage(task.dialogue);
        const availableEmotions = modelDetails[lang] || modelDetails[Object.keys(modelDetails)[0]];
        if (Array.isArray(availableEmotions) && !availableEmotions.includes(currentEmotion)) {
            currentEmotion = '默认';
        }
    }

    if (task.character && characterVoices[task.character]) {
        const cs = characterVoices[task.character];
        if (typeof cs === 'object' && cs.speed) currentSpeed = cs.speed;
    }

    const cacheKey = generateCacheKey(task.dialogue, task.voice, { emotion: currentEmotion, speedFacter: currentSpeed, ttsApiVersion: task.version || ttsApiVersion });

    if (!task.bypassCache && audioCache.has(cacheKey)) {
        const cached = audioCache.get(cacheKey);
        if (cached.timestamp > Date.now() - 300000) return { ...cached, fromCache: true };
        if (cached.blobUrl) URL.revokeObjectURL(cached.blobUrl);
        audioCache.delete(cacheKey);
    }

    if (!task.bypassCache && generationPromises.has(cacheKey)) {
        return await generationPromises.get(cacheKey);
    }

    while (currentGenerations >= maxConcurrentGenerations) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    currentGenerations++;

    const generationPromise = new Promise((resolve, reject) => {
        const lang = detectLanguage(task.dialogue);
        const params = {
            text: task.dialogue, model_name: task.voice, text_lang: lang, prompt_text_lang: lang,
            version: task.version || ttsApiVersion, dl_url: ttsApiBaseUrl,
            batch_size: 10, batch_threshold: 0.75, emotion: currentEmotion, fragment_interval: 0.3,
            if_sr: false, media_type: "wav", parallel_infer: true, repetition_penalty: 1.35,
            sample_steps: 16, seed: -1, speed_facter: currentSpeed, split_bucket: true,
            temperature: 1, text_split_method: "按标点符号切", top_k: 10, top_p: 1
        };

        makeRequest(TTS_API_ENDPOINT_INFER, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(params),
            timeout: 30000
        }).then(response => {
            currentGenerations--;
            generationPromises.delete(cacheKey);

            if (response.status === 200) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.audio_url) {
                        const result = { url: data.audio_url, timestamp: Date.now(), task };
                        audioCache.set(cacheKey, result);
                        cleanupCache();
                        resolve(result);
                    } else reject(new Error(data.reason || "API未返回audio_url"));
                } catch (e) { reject(new Error("无法解析服务器响应")); }
            } else reject(new Error(`TTS API 错误: ${response.status}`));
        }).catch(error => {
            currentGenerations--;
            generationPromises.delete(cacheKey);
            reject(new Error(`无法连接到TTS服务器: ${error.message}`));
        });
    });

    generationPromises.set(cacheKey, generationPromise);
    return await generationPromise;
}

async function generateAudioSequentially(tasks) {
    const results = [];
    for (const task of tasks) {
        try {
            const result = await generateSingleAudio(task);
            results.push(result);
        } catch (error) {
            console.error('音频生成失败:', error);
        }
    }
    return results;
}

// 预加载
async function preloadNextAudio() {
    if (!preloadEnabled || playbackQueue.length < 2) return;
    const nextIndex = currentPlaybackIndex + 1;
    if (nextIndex >= playbackQueue.length) return;
    const nextTask = playbackQueue[nextIndex];
    if (nextTask && !nextTask.preloaded) {
        try {
            nextTask.preloadedBlobUrl = await fetchAudioBlob(nextTask.url);
            nextTask.preloaded = true;
        } catch (error) { console.warn('预加载失败:', error); }
    }
}

// 获取模型列表
async function fetchTTSModels() {
    try {
        const response = await makeRequest(TTS_API_ENDPOINT_MODELS, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ version: ttsApiVersion }),
            timeout: 10000
        });

        if (response.status === 200) {
            const data = JSON.parse(response.responseText);
            ttsModelsWithDetails = data.models || {};
            ttsModels = Object.keys(ttsModelsWithDetails);
            if (ttsModels.length > 0 && !defaultVoice) {
                defaultVoice = ttsModels[0];
                saveSettings();
            }
            populateVoiceSelects();
            updateEmotionSelect(defaultVoice);
            toastr.success(`成功加载 ${ttsModels.length} 个语音模型`, 'TTS');
        } else {
            throw new Error(`服务器返回错误状态: ${response.status}`);
        }
    } catch (error) {
        console.error("[GPT-SoVITS] 获取TTS模型失败:", error);
        toastr.error(`获取语音模型失败: ${error.message}`, 'TTS');
    }
}

// 播放音频
function playAudio(blobUrl) {
    return new Promise((resolve, reject) => {
        let audioPlayer = document.getElementById('tts-audio-player');
        if (!audioPlayer) {
            audioPlayer = document.createElement('audio');
            audioPlayer.id = 'tts-audio-player';
            audioPlayer.style.display = 'none';
            document.body.appendChild(audioPlayer);
        }
        currentAudio = audioPlayer;

        const cleanup = () => {
            URL.revokeObjectURL(blobUrl);
            currentAudio.removeEventListener('ended', onEnded);
            currentAudio.removeEventListener('error', onError);
        };
        const onEnded = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); if (isPlaying) reject(new Error("音频播放失败")); };

        currentAudio.addEventListener('ended', onEnded);
        currentAudio.addEventListener('error', onError);
        currentAudio.src = blobUrl;
        currentAudio.play().catch(onError);
    });
}

// UI更新
function populateVoiceSelects() {
    const selects = document.querySelectorAll('.tts-voice-select');
    selects.forEach(select => {
        const currentValue = select.value;
        select.innerHTML = `<option value="">-- 选择语音 --</option><option value="${DO_NOT_PLAY_VALUE}">不播放</option>`;
        ttsModels.forEach(model => {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            select.appendChild(opt);
        });
        if (currentValue) select.value = currentValue;
    });
}

// 根据识别模式更新设置面板可见性
function updateSettingsVisibility() {
    const narrationSetting = document.getElementById('narration-voice-setting');
    const dialogueSetting = document.getElementById('dialogue-voice-setting');
    const characterSection = document.getElementById('character-voices-section');
    const characterGroupsSection = document.getElementById('character-groups-section');
    const defaultSetting = document.getElementById('default-voice-setting');
    const globalSpeedSetting = document.getElementById('global-speed-setting');

    if (!narrationSetting || !dialogueSetting || !characterSection || !defaultSetting || !characterGroupsSection || !globalSpeedSetting) return;

    if (detectionMode === 'narration_and_dialogue') {
        // 旁白对话模式：显示旁白语音、对话语音
        narrationSetting.style.display = 'block';
        dialogueSetting.style.display = 'block';
        characterSection.style.display = 'none';
        characterGroupsSection.style.display = 'none';
        defaultSetting.style.display = 'none';
        globalSpeedSetting.style.display = 'block';
    } else if (detectionMode === 'character_and_dialogue' || detectionMode === 'character_emotion_and_dialogue') {
        // 角色对话模式：显示角色设置、分组管理、默认语音
        narrationSetting.style.display = 'none';
        dialogueSetting.style.display = 'none';
        characterSection.style.display = 'block';
        characterGroupsSection.style.display = 'block';
        defaultSetting.style.display = 'block';
        globalSpeedSetting.style.display = 'none';
    } else if (detectionMode === 'emotion_and_dialogue') {
        // 情绪对话模式：显示对话语音、默认语音
        narrationSetting.style.display = 'none';
        dialogueSetting.style.display = 'block';
        characterSection.style.display = 'none';
        characterGroupsSection.style.display = 'none';
        defaultSetting.style.display = 'block';
        globalSpeedSetting.style.display = 'block';
    } else {
        // 其他模式：只显示默认语音和语速
        narrationSetting.style.display = 'none';
        dialogueSetting.style.display = 'none';
        characterSection.style.display = 'none';
        characterGroupsSection.style.display = 'none';
        defaultSetting.style.display = 'block';
        globalSpeedSetting.style.display = 'block';
    }
}

function updateEmotionSelect(voiceName) {
    const emotionSelect = document.getElementById('tts-emotion-select');
    if (!emotionSelect) return;
    emotionSelect.innerHTML = '<option value="默认">默认</option>';
    if (voiceName && ttsModelsWithDetails[voiceName]) {
        const allEmotions = new Set();
        Object.values(ttsModelsWithDetails[voiceName]).forEach(emotions => {
            if (Array.isArray(emotions)) emotions.forEach(e => allEmotions.add(e));
        });
        allEmotions.forEach(e => {
            if (e !== '默认') {
                const opt = document.createElement('option');
                opt.value = e;
                opt.textContent = e;
                emotionSelect.appendChild(opt);
            }
        });
    }
    emotionSelect.value = emotion;
}

// 填充感情选择器
function populateEmotionSelect(emotions) {
    const select = document.getElementById('tts-emotion-select');
    if (!select) return;
    const currentEmotion = emotion;
    select.innerHTML = '';
    emotions.forEach(emo => {
        const option = document.createElement('option');
        option.value = emo;
        option.textContent = emo;
        select.appendChild(option);
    });
    if (emotions.includes(currentEmotion)) {
        select.value = currentEmotion;
    } else {
        select.value = emotions[0] || '默认';
    }
    if (emotion !== select.value) {
        emotion = select.value;
        saveSettings();
    }
}

// 渲染角色语音设置
async function renderCharacterVoices() {
    const container = document.getElementById('character-voices-container');
    if (!container) return;

    if (allDetectedCharacters.size === 0) {
        container.innerHTML = '<p class="tts-empty-state">暂无检测到的角色</p>';
        return;
    }

    // 获取已分组的角色
    const assignedCharacters = new Set();
    Object.values(characterGroups).forEach(group => {
        if (group.characters) group.characters.forEach(char => assignedCharacters.add(char));
    });

    // 只显示未分组的角色
    const unassignedCharacters = Array.from(allDetectedCharacters).filter(char => !assignedCharacters.has(char));

    if (unassignedCharacters.length === 0) {
        container.innerHTML = '<p class="tts-empty-state">所有角色都已分组，请在上方分组中配置语音</p>';
        return;
    }

    container.innerHTML = '';
    for (const char of unassignedCharacters) {
        const charDiv = document.createElement('div');
        charDiv.className = 'tts-character-item';

        const voiceSetting = characterVoices[char];
        const voice = typeof voiceSetting === 'object' ? voiceSetting.voice || '' : voiceSetting || '';
        const version = typeof voiceSetting === 'object' ? voiceSetting.version || ttsApiVersion : ttsApiVersion;
        const speed = typeof voiceSetting === 'object' ? voiceSetting.speed || 1.0 : 1.0;
        const modelsForVersion = await getModelsForVersion(version);

        charDiv.innerHTML = `
            <div class="tts-character-header">
                <span class="character-name">${char}</span>
                <button class="tts-delete-char" data-char="${char}">×</button>
            </div>
            <div class="tts-character-controls">
                <select class="tts-character-version" data-char="${char}">
                    ${['v2', 'v2Pro', 'v2ProPlus', 'v3', 'v4'].map(v => `<option value="${v}" ${version === v ? 'selected' : ''}>${v}</option>`).join('')}
                </select>
                <select class="tts-character-voice" data-char="${char}">
                    <option value="">» 使用默认 «</option>
                    <option value="${DO_NOT_PLAY_VALUE}" ${voice === DO_NOT_PLAY_VALUE ? 'selected' : ''}>🔇 不播放</option>
                    ${modelsForVersion.map(model => `<option value="${model}" ${voice === model ? 'selected' : ''}>${model}</option>`).join('')}
                </select>
                <div class="tts-character-speed-control">
                    <label>语速: <span class="tts-character-speed-value" data-char="${char}">${speed}</span></label>
                    <input type="range" class="tts-character-speed-slider" data-char="${char}" min="0.5" max="2.0" step="0.01" value="${speed}">
                </div>
            </div>
        `;
        container.appendChild(charDiv);
    }

    updateSingleCharacterSelector();
    bindCharacterVoiceEvents(container);
}

// 绑定角色语音事件
function bindCharacterVoiceEvents(container) {
    // 版本切换
    container.querySelectorAll('.tts-character-version').forEach(select => {
        select.addEventListener('change', async (e) => {
            const char = e.target.dataset.char;
            const newVersion = e.target.value;
            const voiceSelect = e.target.closest('.tts-character-controls').querySelector('.tts-character-voice');
            const currentVoice = voiceSelect.value;
            const models = await getModelsForVersion(newVersion);
            voiceSelect.innerHTML = `<option value="">» 使用默认 «</option><option value="${DO_NOT_PLAY_VALUE}">🔇 不播放</option>${models.map(model => `<option value="${model}">${model}</option>`).join('')}`;
            if (models.includes(currentVoice)) voiceSelect.value = currentVoice;
            else voiceSelect.value = '';
            voiceSelect.dispatchEvent(new Event('change'));
        });
    });

    // 语音选择
    container.querySelectorAll('.tts-character-voice').forEach(select => {
        select.addEventListener('change', (e) => {
            const char = e.target.dataset.char;
            const voice = e.target.value;
            const version = e.target.closest('.tts-character-controls').querySelector('.tts-character-version').value;
            if (voice) characterVoices[char] = { voice, version, speed: characterVoices[char]?.speed || 1.0 };
            else delete characterVoices[char];
            saveSettings();
            updateEmotionSelect(voice || defaultVoice);
        });
    });

    // 语速滑块
    container.querySelectorAll('.tts-character-speed-slider').forEach(slider => {
        const char = slider.dataset.char;
        const speedValue = container.querySelector(`.tts-character-speed-value[data-char="${char}"]`);
        slider.addEventListener('input', (e) => { speedValue.textContent = e.target.value; });
        slider.addEventListener('change', (e) => {
            const speed = parseFloat(e.target.value);
            if (characterVoices[char]) characterVoices[char].speed = speed;
            else characterVoices[char] = { voice: '', version: ttsApiVersion, speed };
            saveSettings();
        });
    });

    // 删除角色
    container.querySelectorAll('.tts-delete-char').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const char = e.target.dataset.char;
            allDetectedCharacters.delete(char);
            delete characterVoices[char];
            Object.keys(characterGroups).forEach(groupName => {
                const group = characterGroups[groupName];
                if (group.characters) {
                    group.characters = group.characters.filter(c => c !== char);
                    if (group.characters.length === 0) delete characterGroups[groupName];
                }
            });
            saveSettings();
            renderCharacterVoices();
            renderCharacterGroups();
        });
    });
}

function updatePlayButton(icon, text) {
    const btn = document.getElementById('tts-play-btn');
    if (btn) btn.innerHTML = `<i class="icon">${icon}</i><span class="text">${text}</span>`;
}


// 播放控制
function handlePlayPauseResumeClick() {
    if (isPlaying && !isPaused) {
        isPaused = true;
        if (currentAudio) currentAudio.pause();
        updatePlayButton('▶', '继续');
        return;
    }
    if (isPlaying && isPaused) {
        isPaused = false;
        updatePlayButton('⏸', '暂停');
        if (currentAudio) currentAudio.play();
        else processPlaybackQueue();
        return;
    }
    if (ttsModels.length === 0) {
        toastr.error("播放失败：无法连接到TTS服务或未找到任何语音模型。", 'TTS');
        return;
    }
    if (lastMessageParts.length === 0) {
        toastr.warning("未找到符合当前识别模式的文本。", 'TTS');
        return;
    }

    const tasksToGenerate = lastMessageParts.map(part => {
        if (isSingleCharacterMode && singleCharacterTarget && part.character !== singleCharacterTarget) return null;

        let voice = '', version = ttsApiVersion, taskEmotion = null;
        const vs = characterVoices[part.character];

        switch (part.type) {
            case 'character_emotion_dialogue':
            case 'character_dialogue':
                voice = typeof vs === 'object' ? (vs.voice || defaultVoice) : (vs || defaultVoice);
                version = typeof vs === 'object' ? (vs.version || ttsApiVersion) : ttsApiVersion;
                if (part.emotion) taskEmotion = part.emotion;
                break;
            case 'emotion_dialogue':
            case 'dialogue':
                voice = dialogueVoice || defaultVoice;
                if (part.emotion) taskEmotion = part.emotion;
                break;
            case 'narration':
                voice = narrationVoice || defaultVoice;
                break;
            default:
                voice = defaultVoice;
        }
        if (voice && voice !== DO_NOT_PLAY_VALUE) {
            return { dialogue: part.dialogue, voice, version, emotion: taskEmotion, character: part.character };
        }
        return null;
    }).filter(Boolean);

    if (tasksToGenerate.length === 0) {
        toastr.warning("没有需要播放的对话内容（请检查语音配置）。", 'TTS');
        return;
    }

    isPlaying = true;
    isPaused = false;
    generationQueue = [...tasksToGenerate];
    playbackQueue = [];
    currentPlaybackIndex = 0;
    $('#tts-stop-btn').show();
    $('#tts-replay-btn, #tts-reinfer-btn').prop('disabled', true);
    processGenerationQueue();
}

function handleStopClick() {
    isPlaying = false;
    isPaused = false;
    generationQueue = [];
    playbackQueue = [];
    isProcessingQueue = false;
    currentPlaybackIndex = 0;
    playbackSequenceId++;
    if (autoPlayTimeout) { clearTimeout(autoPlayTimeout); autoPlayTimeout = null; }
    if (currentAudio) { currentAudio.pause(); currentAudio.src = ''; currentAudio = null; }
    updatePlayButton('▶', '播放');
    $('#tts-play-btn').prop('disabled', lastMessageParts.length === 0);
    $('#tts-stop-btn').hide();
    $('#tts-replay-btn, #tts-reinfer-btn').prop('disabled', lastPlayedQueue.length === 0);
}

function handleReplayClick() {
    if (lastPlayedQueue.length === 0 || isPlaying) return;
    handleStopClick();
    playbackQueue = [...lastPlayedQueue];
    currentPlaybackIndex = 0;
    isPlaying = true;
    updatePlayButton('⏸', '暂停');
    $('#tts-stop-btn').show();
    $('#tts-replay-btn, #tts-reinfer-btn').prop('disabled', true);
    processPlaybackQueue();
}

async function processGenerationQueue() {
    if (!isPlaying || generationQueue.length === 0) return;
    updatePlayButton('⏳', '生成中...');
    $('#tts-play-btn').prop('disabled', true);

    try {
        const results = await generateAudioSequentially(generationQueue);
        playbackQueue.push(...results);
        generationQueue = [];
    } catch (error) {
        console.error('音频生成失败:', error);
        toastr.error('音频生成失败，请检查TTS服务。', 'TTS');
        handleStopClick();
        return;
    }

    if (playbackQueue.length === 0) {
        toastr.error('所有对话都生成失败，请检查TTS服务。', 'TTS');
        handleStopClick();
        return;
    }

    lastPlayedQueue = [...playbackQueue];
    $('#tts-play-btn').prop('disabled', false);
    $('#tts-replay-btn, #tts-reinfer-btn').prop('disabled', false);
    updatePlayButton('⏸', '暂停');
    processPlaybackQueue();
}

async function processPlaybackQueue() {
    if (isProcessingQueue || isPaused) return;
    if (playbackQueue.length === 0 || !isPlaying || currentPlaybackIndex >= playbackQueue.length) {
        if (isPlaying) handleStopClick();
        return;
    }

    isProcessingQueue = true;
    const currentSequenceId = ++playbackSequenceId;

    try {
        const task = playbackQueue[currentPlaybackIndex];
        if (!task) return;

        const blobUrl = task.preloadedBlobUrl || await fetchAudioBlob(task.url);
        if (task.preloadedBlobUrl) task.preloadedBlobUrl = null;

        preloadNextAudio();
        await playAudio(blobUrl);

        if (currentSequenceId === playbackSequenceId && !isPaused) {
            currentPlaybackIndex++;
            setTimeout(() => { isProcessingQueue = false; processPlaybackQueue(); }, 100);
        } else {
            isProcessingQueue = false;
        }
    } catch (error) {
        console.error('播放任务失败:', error);
        if (isPlaying) { toastr.error(`播放失败: ${error.message}`, 'TTS'); handleStopClick(); }
        isProcessingQueue = false;
    }
}

// 消息解析
async function reparseCurrentMessage() {
    const messages = document.querySelectorAll('div.mes[is_user="false"]');
    if (messages.length === 0) return;

    const lastMessageElement = messages[messages.length - 1];
    const messageTextElement = lastMessageElement.querySelector('.mes_text');
    if (!messageTextElement) return;

    const fullText = messageTextElement.innerText;
    const currentMessageParts = [];
    let hasNewCharacter = false;
    const validDialogueRegex = /[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff]/;

    if (detectionMode === 'character_and_dialogue') {
        const regex = /【([^】]+)】\s*「([^」]+?)」/gs;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const character = match[1].trim(), dialogue = match[2].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) {
                currentMessageParts.push({ type: 'character_dialogue', character, dialogue });
                if (character && !allDetectedCharacters.has(character)) {
                    allDetectedCharacters.add(character);
                    characterVoices[character] = DO_NOT_PLAY_VALUE;
                    hasNewCharacter = true;
                }
            }
        }
    } else if (detectionMode === 'character_emotion_and_dialogue') {
        const regex = /【([^】]+)】\s*〈([^〉]+)〉\s*「([^」]+?)」/gs;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const character = match[1].trim(), em = match[2].trim(), dialogue = match[3].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) {
                currentMessageParts.push({ type: 'character_emotion_dialogue', character, emotion: em, dialogue });
                if (character && !allDetectedCharacters.has(character)) {
                    allDetectedCharacters.add(character);
                    characterVoices[character] = DO_NOT_PLAY_VALUE;
                    hasNewCharacter = true;
                }
            }
        }
    } else if (detectionMode === 'narration_and_dialogue') {
        const segments = fullText.split(getDialogueSplitRegex());
        for (const segment of segments) {
            const ts = segment.trim();
            if (!ts) continue;
            if (isDialogueFormat(ts)) {
                const dialogue = extractDialogue(ts);
                if (dialogue && validDialogueRegex.test(dialogue)) currentMessageParts.push({ type: 'dialogue', dialogue });
            } else if (validDialogueRegex.test(ts)) {
                currentMessageParts.push({ type: 'narration', dialogue: ts });
            }
        }
    } else if (detectionMode === 'dialogue_only') {
        const regex = getDialogueRegex();
        const allDialogues = [];
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const dialogue = match[1].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) allDialogues.push(dialogue);
        }
        if (allDialogues.length > 0) currentMessageParts.push({ type: 'dialogue_only', dialogue: allDialogues.join('\n') });
    } else if (detectionMode === 'entire_message') {
        const trimmedText = fullText.trim();
        if (trimmedText) currentMessageParts.push({ type: 'entire_message', dialogue: trimmedText });
    } else if (detectionMode === 'emotion_and_dialogue') {
        const regex = /〈([^〉]+)〉\s*「([^」]+?)」/gs;
        let match;
        while ((match = regex.exec(fullText)) !== null) {
            const em = match[1].trim(), dialogue = match[2].trim();
            if (dialogue && validDialogueRegex.test(dialogue)) currentMessageParts.push({ type: 'emotion_dialogue', emotion: em, dialogue });
        }
    }

    if (hasNewCharacter) saveSettings();
    if (!isPlaying) {
        lastMessageParts = currentMessageParts;
        $('#tts-play-btn').prop('disabled', currentMessageParts.length === 0);
    }
}

// 聊天观察器
function observeChat() {
    let debounceTimer;
    const observerCallback = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const messages = document.querySelectorAll('div.mes[is_user="false"]');
            if (messages.length === 0) return;

            const lastMessageElement = messages[messages.length - 1];
            const messageTextElement = lastMessageElement.querySelector('.mes_text');
            if (!messageTextElement) return;

            const messageId = lastMessageElement.getAttribute('mesid') || lastMessageElement.textContent.substring(0, 50);
            const fullText = messageTextElement.innerText;

            if (lastProcessedMessageId === messageId && lastProcessedText === fullText) return;
            lastProcessedMessageId = messageId;
            lastProcessedText = fullText;

            await reparseCurrentMessage();

            if (autoPlayEnabled && !isPlaying && lastMessageParts.length > 0) {
                if (autoPlayTimeout) { clearTimeout(autoPlayTimeout); autoPlayTimeout = null; }
                autoPlayTimeout = setTimeout(() => {
                    if (!isPlaying && lastMessageParts.length > 0) handlePlayPauseResumeClick();
                }, 800);
            }
        }, 300);
    };

    const observer = new MutationObserver(observerCallback);
    const interval = setInterval(() => {
        const chatContainer = document.querySelector('#chat');
        if (chatContainer) {
            observer.observe(chatContainer, { childList: true, subtree: true, characterData: true });
            clearInterval(interval);
            reparseCurrentMessage();
        }
    }, 500);
}

// 拖拽功能
function makeDraggable(panel) {
    let isDragging = false, startX, startY, startLeft, startTop;

    panel.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, input, select')) return;
        isDragging = true;
        panel.classList.add('dragging');
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top;
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        panel.style.left = `${startLeft + e.clientX - startX}px`;
        panel.style.top = `${startTop + e.clientY - startY}px`;
        panel.style.right = 'auto';
        panel.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) { isDragging = false; panel.classList.remove('dragging'); }
    });
}

// 创建悬浮面板
function createFloatingPanel() {
    if (document.getElementById('tts-floating-panel')) return;

    const panel = $(`
        <div id="tts-floating-panel" class="tts-panel">
            <div class="tts-main-controls">
                <button id="tts-play-btn" class="tts-control-btn primary" disabled><i class="icon">▶</i><span class="text">播放</span></button>
                <button id="tts-stop-btn" class="tts-control-btn danger" style="display:none;"><i class="icon">⏹</i><span class="text">停止</span></button>
                <button id="tts-replay-btn" class="tts-control-btn secondary" disabled><i class="icon">🔁</i><span class="text">重播</span></button>
                <button id="tts-reinfer-btn" class="tts-control-btn secondary" disabled><i class="icon">🔄</i><span class="text">重推</span></button>
                <button id="tts-settings-btn" class="tts-control-btn settings"><i class="icon">⚙</i><span class="text">设置</span></button>
            </div>
        </div>
    `);

    $('body').append(panel);
    makeDraggable(panel[0]);

    $('#tts-play-btn').on('click', handlePlayPauseResumeClick);
    $('#tts-stop-btn').on('click', handleStopClick);
    $('#tts-replay-btn').on('click', handleReplayClick);
    $('#tts-reinfer-btn').on('click', handlePlayPauseResumeClick);
    $('#tts-settings-btn').on('click', createSettingsModal);
}

// 创建设置弹窗 (完整版)
function createSettingsModal() {
    if ($('#tts-settings-modal').length) { $('#tts-settings-modal').remove(); return; }

    const characterListHtml = allDetectedCharacters.size > 0
        ? Array.from(allDetectedCharacters).map(char => {
            const vs = characterVoices[char];
            const currentVoice = typeof vs === 'object' ? vs.voice : vs;
            const currentVersion = typeof vs === 'object' ? vs.version : ttsApiVersion;
            const currentSpeed = typeof vs === 'object' ? (vs.speed || 1.0) : 1.0;
            return `
                <div class="tts-character-item" data-character="${char}">
                    <div class="tts-character-header">
                        <span class="character-name">${char}</span>
                        <button class="tts-delete-char" data-character="${char}">×</button>
                    </div>
                    <div class="tts-character-controls">
                        <select class="tts-character-voice tts-voice-select" data-character="${char}"></select>
                        <select class="tts-character-version" data-character="${char}">
                            <option value="v2" ${currentVersion === 'v2' ? 'selected' : ''}>v2</option>
                            <option value="v3" ${currentVersion === 'v3' ? 'selected' : ''}>v3</option>
                            <option value="v4" ${currentVersion === 'v4' ? 'selected' : ''}>v4</option>
                        </select>
                        <div class="tts-character-speed-control">
                            <label>语速: <span class="tts-character-speed-value">${currentSpeed.toFixed(1)}</span></label>
                            <input type="range" class="tts-character-speed-slider" data-character="${char}" min="0.5" max="2.0" step="0.1" value="${currentSpeed}">
                        </div>
                    </div>
                </div>`;
        }).join('')
        : '<p class="tts-empty-state">暂无检测到的角色</p>';

    const modal = $(`
        <div id="tts-settings-modal" class="tts-modal">
            <div class="tts-modal-content">
                <div class="tts-modal-header">
                    <h2>⚙ TTS设置 <span class="version">v1.0.0</span></h2>
                    <button class="tts-close-btn">×</button>
                </div>
                <div class="tts-modal-body">
                    <div class="tts-setting-section">
                        <h3>🔧 API设置</h3>
                        <div class="tts-setting-item"><label>TTS API 地址</label><input type="text" id="tts-api-url" value="${ttsApiBaseUrl}"></div>
                        <div class="tts-setting-item"><label>API 版本</label>
                            <select id="tts-api-version">
                                <option value="v2" ${ttsApiVersion === 'v2' ? 'selected' : ''}>v2</option>
                                <option value="v3" ${ttsApiVersion === 'v3' ? 'selected' : ''}>v3</option>
                                <option value="v4" ${ttsApiVersion === 'v4' ? 'selected' : ''}>v4</option>
                            </select>
                        </div>
                        <div class="tts-setting-item" style="display:flex;gap:10px;">
                            <button id="tts-test-connection" class="menu_button">测试连接</button>
                            <button id="tts-refresh-models" class="menu_button">刷新模型</button>
                        </div>
                    </div>
                    
                    <div class="tts-setting-section">
                        <h3>🎯 识别模式</h3>
                        <div class="tts-radio-group">
                            <label class="tts-radio-item"><input type="radio" name="detection-mode" value="character_and_dialogue" ${detectionMode === 'character_and_dialogue' ? 'checked' : ''}><span>【角色】「对话」</span></label>
                            <label class="tts-radio-item"><input type="radio" name="detection-mode" value="character_emotion_and_dialogue" ${detectionMode === 'character_emotion_and_dialogue' ? 'checked' : ''}><span>【角色】〈情绪〉「对话」</span></label>
                            <label class="tts-radio-item"><input type="radio" name="detection-mode" value="emotion_and_dialogue" ${detectionMode === 'emotion_and_dialogue' ? 'checked' : ''}><span>〈情绪〉「对话」</span></label>
                            <label class="tts-radio-item"><input type="radio" name="detection-mode" value="narration_and_dialogue" ${detectionMode === 'narration_and_dialogue' ? 'checked' : ''}><span>旁白与对话</span></label>
                            <label class="tts-radio-item"><input type="radio" name="detection-mode" value="dialogue_only" ${detectionMode === 'dialogue_only' ? 'checked' : ''}><span>仅「对话」</span></label>
                            <label class="tts-radio-item"><input type="radio" name="detection-mode" value="entire_message" ${detectionMode === 'entire_message' ? 'checked' : ''}><span>朗读整段</span></label>
                        </div>
                    </div>
                    
                    <div class="tts-setting-section">
                        <h3>📝 引号样式</h3>
                        <div class="tts-toggle-group">
                            <label class="tts-toggle-item ${quotationStyle === 'japanese' ? 'active' : ''}"><input type="radio" name="quotation-style" value="japanese" ${quotationStyle === 'japanese' ? 'checked' : ''}><span>日式「」</span></label>
                            <label class="tts-toggle-item ${quotationStyle === 'western' ? 'active' : ''}"><input type="radio" name="quotation-style" value="western" ${quotationStyle === 'western' ? 'checked' : ''}><span>西式""</span></label>
                        </div>
                    </div>
                    
                    <div class="tts-setting-section">
                        <h3>🎙️ 语音设置</h3>
                        <div class="tts-setting-item" id="default-voice-setting"><label>默认语音</label><select id="tts-default-voice" class="tts-voice-select"></select></div>
                        <div class="tts-setting-item" id="narration-voice-setting"><label>旁白语音</label><select id="tts-narration-voice" class="tts-voice-select"></select></div>
                        <div class="tts-setting-item" id="dialogue-voice-setting"><label>对话语音</label><select id="tts-dialogue-voice" class="tts-voice-select"></select></div>
                        <div class="tts-setting-item"><label>默认情感</label><select id="tts-emotion-select"><option value="默认">默认</option></select></div>
                        <div class="tts-setting-item" id="global-speed-setting"><label>语速 <span id="speed-value">${speedFacter.toFixed(1)}</span></label><input type="range" id="tts-speed" min="0.5" max="2.0" step="0.1" value="${speedFacter}"></div>
                    </div>
                    
                    <div class="tts-setting-section">
                        <h3>⚡ 功能开关</h3>
                        <div class="tts-setting-item">
                            <label class="tts-switch-label">
                                <span>自动播放</span>
                                <input type="checkbox" id="tts-auto-play" ${autoPlayEnabled ? 'checked' : ''}>
                                <span class="tts-switch-slider"></span>
                            </label>
                            <p class="tts-setting-desc">收到新消息后自动开始TTS播放</p>
                        </div>
                        <div class="tts-setting-item">
                            <label class="tts-switch-label">
                                <span>前端美化适配</span>
                                <input type="checkbox" id="tts-frontend-adaptation" ${frontendAdaptationEnabled ? 'checked' : ''}>
                                <span class="tts-switch-slider"></span>
                            </label>
                            <p class="tts-setting-desc">启用后可从juus本体等美化前端中解析文本（暂未完全支持）</p>
                        </div>
                    </div>
                    
                    <div class="tts-setting-section" id="character-groups-section">
                        <h3>📂 角色分组管理</h3>
                        <div class="tts-group-controls" style="display:flex;gap:10px;margin-bottom:16px;">
                            <input type="text" id="new-group-name" placeholder="输入分组名称" style="flex:1;">
                            <input type="color" id="new-group-color" value="#667eea" style="width:40px;height:36px;border-radius:8px;border:1px solid #ced4da;">
                            <button id="tts-create-group" class="menu_button">创建分组</button>
                        </div>
                        <div id="character-groups-container"></div>
                    </div>
                    
                    <div class="tts-setting-section" id="character-voices-section">
                        <h3>👥 检测到的角色</h3>
                        <div id="character-voices-container"></div>
                    </div>
                </div>
            </div>
        </div>
    `);

    $('body').append(modal);

    // 填充语音选择下拉框
    populateVoiceSelects();
    $('#tts-default-voice').val(defaultVoice);
    $('#tts-narration-voice').val(narrationVoice);
    $('#tts-dialogue-voice').val(dialogueVoice);
    updateEmotionSelect(defaultVoice);

    // 填充角色语音选择
    allDetectedCharacters.forEach(char => {
        const vs = characterVoices[char];
        const currentVoice = typeof vs === 'object' ? vs.voice : vs;
        const select = modal.find(`.tts-character-voice[data-character="${char}"]`);
        select.html(`<option value="">-- 选择语音 --</option><option value="${DO_NOT_PLAY_VALUE}">不播放</option>`);
        ttsModels.forEach(model => {
            select.append(`<option value="${model}" ${model === currentVoice ? 'selected' : ''}>${model}</option>`);
        });
    });

    // 渲染分组和角色语音
    renderCharacterGroups();
    renderCharacterVoices();

    // 根据识别模式更新设置项可见性
    updateSettingsVisibility();

    // 事件绑定
    modal.find('.tts-close-btn').on('click', () => modal.remove());
    modal.on('click', (e) => { if (e.target === modal[0]) modal.remove(); });

    // API设置
    $('#tts-api-url').on('change', function () { ttsApiBaseUrl = $(this).val().replace(/\/$/, ''); updateApiEndpoints(); saveSettings(); });
    $('#tts-api-version').on('change', function () { ttsApiVersion = $(this).val(); saveSettings(); fetchTTSModels(); });
    $('#tts-test-connection').on('click', async function () {
        try {
            toastr.info('正在测试连接...', 'TTS');
            const response = await makeRequest(TTS_API_ENDPOINT_MODELS, { method: "POST", headers: { "Content-Type": "application/json" }, data: JSON.stringify({ version: ttsApiVersion }), timeout: 5000 });
            if (response.status === 200) toastr.success('连接成功！', 'TTS');
            else toastr.error(`连接失败: ${response.status}`, 'TTS');
        } catch (error) { toastr.error(`连接失败: ${error.message}`, 'TTS'); }
    });
    $('#tts-refresh-models').on('click', fetchTTSModels);

    // 识别模式
    $('input[name="detection-mode"]').on('change', function () { detectionMode = $(this).val(); saveSettings(); updateSettingsVisibility(); reparseCurrentMessage(); });

    // 引号样式
    $('input[name="quotation-style"]').on('change', function () {
        quotationStyle = $(this).val();
        $('.tts-toggle-item').removeClass('active');
        $(this).closest('.tts-toggle-item').addClass('active');
        saveSettings();
        reparseCurrentMessage();
    });

    // 语音设置
    $('#tts-default-voice').on('change', function () { defaultVoice = $(this).val(); updateEmotionSelect(defaultVoice); saveSettings(); });
    $('#tts-narration-voice').on('change', function () { narrationVoice = $(this).val(); saveSettings(); });
    $('#tts-dialogue-voice').on('change', function () { dialogueVoice = $(this).val(); saveSettings(); });
    $('#tts-emotion-select').on('change', function () { emotion = $(this).val(); saveSettings(); });
    $('#tts-speed').on('input', function () { speedFacter = parseFloat($(this).val()); $('#speed-value').text(speedFacter.toFixed(1)); saveSettings(); });

    // 功能开关
    $('#tts-auto-play').on('change', function () { autoPlayEnabled = $(this).is(':checked'); saveSettings(); });
    $('#tts-frontend-adaptation').on('change', function () { frontendAdaptationEnabled = $(this).is(':checked'); saveSettings(); });

    // 创建分组
    $('#tts-create-group').on('click', function () {
        const groupName = $('#new-group-name').val().trim();
        const groupColor = $('#new-group-color').val();
        if (!groupName) { showNotification('请输入分组名称', 'warning'); return; }
        if (characterGroups[groupName]) { showNotification('分组已存在', 'warning'); return; }
        characterGroups[groupName] = { color: groupColor, characters: [] };
        saveSettings();
        renderCharacterGroups();
        renderCharacterVoices();
        $('#new-group-name').val('');
        showNotification(`分组 "${groupName}" 已创建`, 'success');
    });


    // 角色设置
    modal.on('change', '.tts-character-voice', function () {
        const char = $(this).data('character');
        const item = $(this).closest('.tts-character-item');
        characterVoices[char] = { voice: $(this).val(), version: item.find('.tts-character-version').val(), speed: parseFloat(item.find('.tts-character-speed-slider').val()) };
        saveSettings();
    });
    modal.on('change', '.tts-character-version', function () {
        const char = $(this).data('character');
        const item = $(this).closest('.tts-character-item');
        characterVoices[char] = { voice: item.find('.tts-character-voice').val(), version: $(this).val(), speed: parseFloat(item.find('.tts-character-speed-slider').val()) };
        saveSettings();
    });
    modal.on('input', '.tts-character-speed-slider', function () {
        const char = $(this).data('character');
        const item = $(this).closest('.tts-character-item');
        const speed = parseFloat($(this).val());
        item.find('.tts-character-speed-value').text(speed.toFixed(1));
        characterVoices[char] = { voice: item.find('.tts-character-voice').val(), version: item.find('.tts-character-version').val(), speed };
        saveSettings();
    });
    modal.on('click', '.tts-delete-char', function () {
        const char = $(this).data('character');
        allDetectedCharacters.delete(char);
        delete characterVoices[char];
        saveSettings();
        $(this).closest('.tts-character-item').remove();
        if (allDetectedCharacters.size === 0) {
            $('#tts-character-list').html('<p class="tts-empty-state">暂无检测到的角色</p>');
        }
    });
}

// ========== 入口点 ==========
jQuery(async () => {
    console.log('[GPT-SoVITS TTS] 扩展加载中...');

    loadSettings();

    // 加载CSS
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${extensionFolderPath}style.css`;
    document.head.appendChild(link);

    // 创建设置面板入口
    const settingsHtml = `
        <div class="tts-extension-settings">
            <p>TTS播放器已加载。悬浮控制面板显示在页面右侧。</p>
            <button id="tts-reset-panel" class="menu_button">重置悬浮窗位置</button>
            <button id="tts-refresh-models-btn" class="menu_button">刷新模型列表</button>
        </div>
    `;

    const extensionPanel = $(`
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🔊 GPT-SoVITS TTS播放器</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${settingsHtml}
            </div>
        </div>
    `);

    $('#extensions_settings2').append(extensionPanel);

    // 绑定按钮
    $('#tts-reset-panel').on('click', () => {
        const panel = document.getElementById('tts-floating-panel');
        if (panel) {
            panel.style.left = '';
            panel.style.top = '50%';
            panel.style.right = '20px';
            panel.style.transform = 'translateY(-50%)';
            toastr.success('悬浮窗位置已重置', 'TTS');
        }
    });
    $('#tts-refresh-models-btn').on('click', fetchTTSModels);

    // 创建悬浮面板
    createFloatingPanel();

    // 获取模型
    await fetchTTSModels();

    // 启动聊天观察器
    observeChat();

    console.log('[GPT-SoVITS TTS] 扩展加载完成');
});
