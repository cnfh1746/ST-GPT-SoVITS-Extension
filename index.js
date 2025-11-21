(async function () {
    'use strict';

    const EXTENSION_NAME = "ST-GPT-SoVITS-Extension";
    const SETTINGS_KEY = "gpt_sovits_player";

    // 确保 extension_settings 中有我们的 key
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = {};
    }

    // API地址配置变量
    let ttsApiBaseUrl = "http://127.0.0.1:8000"; // 默认本地地址
    let TTS_API_ENDPOINT_INFER = "";
    let TTS_API_ENDPOINT_MODELS = "";

    const DO_NOT_PLAY_VALUE = '_DO_NOT_PLAY_';
    const DEFAULT_DETECTION_MODE = 'character_and_dialogue';

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
        // 简单封装，避免无限递归
        const logHandler = (type, ...args) => {
            try {
                consoleLogs.push({
                    type: type,
                    message: args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)).join(' '),
                    timestamp: new Date().toLocaleTimeString()
                });
                // 限制日志数量
                if (consoleLogs.length > 1000) consoleLogs.shift();
            } catch (e) {
                // 忽略日志记录错误
            }
        };

        // 这里不覆盖全局console，而是提供一个内部logger，或者在需要时手动记录
        // 为了保持脚本逻辑一致性，我们还是覆盖，但要小心
        // 在ST环境中覆盖全局console可能有风险，改为只记录关键信息
    }

    // 更新API端点地址
    function updateApiEndpoints() {
        TTS_API_ENDPOINT_INFER = `${ttsApiBaseUrl}/infer_single`;
        TTS_API_ENDPOINT_MODELS = `${ttsApiBaseUrl}/models`;
    }

    let ttsApiVersion = 'v4';
    let detectionMode = DEFAULT_DETECTION_MODE;
    let speedFacter = 1.0;
    let emotion = '默认';
    let narrationVoice = '';
    let dialogueVoice = '';
    let ttsModels = [], ttsModelsWithDetails = {}, characterVoices = {}, defaultVoice = '', allDetectedCharacters = new Set(),
        characterGroups = {},
        lastMessageParts = [],
        generationQueue = [],
        playbackQueue = [],
        lastPlayedQueue = [],
        isPlaying = false, isPaused = false, currentAudio = null;

    // 播放队列锁定和序列跟踪
    let isProcessingQueue = false;
    let currentPlaybackIndex = 0;
    let playbackSequenceId = 0;

    // 流式播放相关变量
    let isStreamingMode = false;
    let streamingSegments = [];
    let currentStreamingIndex = 0;
    let streamingAudioCache = new Map();
    
    // 模型缓存
    let modelCache = new Map();

    // 性能优化相关变量
    let audioCache = new Map();
    let generationPromises = new Map();
    let maxConcurrentGenerations = 3;
    let currentGenerations = 0;
    let preloadEnabled = true;
    let batchMode = true;

    // 新增功能变量
    let autoPlayEnabled = false;
    let quotationStyle = 'japanese';
    let edgeMode = false; // 边缘依附模式

    // 前端美化适配相关变量
    let frontendAdaptationEnabled = false; // 前端美化适配开关

    // 单角色模式相关变量
    let isSingleCharacterMode = false; // 单角色模式开关
    let singleCharacterTarget = ''; // 当前选择的单角色目标

    // 修复重复播放问题的变量
    let lastProcessedMessageId = null;
    let lastProcessedText = ''; 
    let autoPlayTimeout = null;

    const Settings = {
        load: function() {
            const settings = extension_settings[SETTINGS_KEY] || {};
            
            ttsApiBaseUrl = settings.ttsApiBaseUrl || 'http://127.0.0.1:8000';
            updateApiEndpoints();
            
            ttsApiVersion = settings.ttsApiVersion || 'v4';
            detectionMode = settings.detectionMode || DEFAULT_DETECTION_MODE;
            speedFacter = settings.speedFacter || 1.0;
            emotion = settings.emotion || '默认';
            narrationVoice = settings.narrationVoice || '';
            dialogueVoice = settings.dialogueVoice || '';
            characterVoices = settings.characterVoices || {};
            characterGroups = settings.characterGroups || {};
            defaultVoice = settings.defaultVoice || '';
            
            const savedChars = settings.allDetectedCharacters || [];
            allDetectedCharacters = new Set(savedChars);
            
            maxConcurrentGenerations = settings.maxConcurrentGenerations || 3;
            preloadEnabled = settings.preloadEnabled !== undefined ? settings.preloadEnabled : true;
            batchMode = settings.batchMode !== undefined ? settings.batchMode : true;
            autoPlayEnabled = settings.autoPlayEnabled || false;
            quotationStyle = settings.quotationStyle || 'japanese';
            edgeMode = settings.edgeMode || false;
            frontendAdaptationEnabled = settings.frontendAdaptationEnabled || false;
            isSingleCharacterMode = settings.isSingleCharacterMode || false;
            singleCharacterTarget = settings.singleCharacterTarget || '';
        },
        save: function() {
            if (!extension_settings[SETTINGS_KEY]) extension_settings[SETTINGS_KEY] = {};
            
            extension_settings[SETTINGS_KEY] = {
                ttsApiBaseUrl,
                ttsApiVersion,
                detectionMode,
                speedFacter,
                emotion,
                narrationVoice,
                dialogueVoice,
                characterVoices,
                characterGroups,
                defaultVoice,
                allDetectedCharacters: Array.from(allDetectedCharacters),
                maxConcurrentGenerations,
                preloadEnabled,
                batchMode,
                autoPlayEnabled,
                quotationStyle,
                edgeMode,
                frontendAdaptationEnabled,
                isSingleCharacterMode,
                singleCharacterTarget
            };
            
            saveSettingsDebounced();
        }
    };

    // 生成缓存键
    function generateCacheKey(text, voice, params) {
        return `${voice}_${text}_${JSON.stringify(params)}`;
    }

    // 清理过期缓存
    function cleanupCache() {
        if (audioCache.size > 50) {
            const keys = Array.from(audioCache.keys());
            const keysToDelete = keys.slice(0, keys.length - 30);
            keysToDelete.forEach(key => {
                const cached = audioCache.get(key);
                if (cached && cached.blobUrl) {
                    URL.revokeObjectURL(cached.blobUrl);
                }
                audioCache.delete(key);
            });
        }
    }

    // 顺序生成音频
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

    // ... (流式播放相关函数略，基本不需要修改，除了 fetchAudioBlob) ...
    // 为了节省空间，这里直接引用后续的 fetchAudioBlob

    // 单个音频生成（带缓存）
    async function generateSingleAudio(task) {
        let currentEmotion = task.emotion || emotion;

        const modelDetails = ttsModelsWithDetails[task.voice];
        if (currentEmotion !== '默认' && modelDetails) {
            const lang = detectLanguage(task.dialogue);
            const availableEmotions = modelDetails[lang] || modelDetails[Object.keys(modelDetails)[0]];
            if (Array.isArray(availableEmotions) && !availableEmotions.includes(currentEmotion)) {
                currentEmotion = '默认';
            }
        }

        let currentSpeed = speedFacter;
        if ((detectionMode === 'character_and_dialogue' || detectionMode === 'character_emotion_and_dialogue') && task.character) {
            const characterSetting = characterVoices[task.character];
            if (characterSetting && typeof characterSetting === 'object' && characterSetting.speed) {
                currentSpeed = characterSetting.speed;
            }
        }

        const cacheKey = generateCacheKey(task.dialogue, task.voice, {
            emotion: currentEmotion, speedFacter: currentSpeed, ttsApiVersion: task.version || ttsApiVersion
        });

        if (!task.bypassCache) {
            if (audioCache.has(cacheKey)) {
                const cached = audioCache.get(cacheKey);
                if (cached.timestamp > Date.now() - 300000) {
                    return { ...cached, fromCache: true };
                } else {
                    if (cached.blobUrl) {
                        URL.revokeObjectURL(cached.blobUrl);
                    }
                    audioCache.delete(cacheKey);
                }
            }

            if (generationPromises.has(cacheKey)) {
                return await generationPromises.get(cacheKey);
            }
        }

        while (currentGenerations >= maxConcurrentGenerations) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        currentGenerations++;

        const generationPromise = new Promise((resolve, reject) => {
            const lang = detectLanguage(task.dialogue);
            const params = {
                text: task.dialogue,
                model_name: task.voice,
                text_lang: lang,
                prompt_text_lang: lang,
                version: task.version || ttsApiVersion,
                dl_url: ttsApiBaseUrl,
                batch_size: task.isBatch ? 20 : 10,
                batch_threshold: 0.75,
                emotion: currentEmotion,
                fragment_interval: 0.3,
                if_sr: false,
                media_type: "wav",
                parallel_infer: true,
                repetition_penalty: 1.35,
                sample_steps: 16,
                seed: -1,
                speed_facter: currentSpeed,
                split_bucket: true,
                temperature: 1,
                text_split_method: "按标点符号切",
                top_k: 10,
                top_p: 1
            };

            makeRequest(TTS_API_ENDPOINT_INFER, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(params), // fetch 用 body
                timeout: 30000
            }).then(async response => {
                currentGenerations--;
                generationPromises.delete(cacheKey);

                if (response.ok) {
                    try {
                        const data = await response.json();
                        if (data.audio_url) {
                            const result = {
                                url: data.audio_url,
                                timestamp: Date.now(),
                                task: task
                            };

                            audioCache.set(cacheKey, result);
                            cleanupCache();
                            resolve(result);
                        } else {
                            reject(new Error(data.reason || "API未返回audio_url"));
                        }
                    } catch (e) {
                        reject(new Error("无法解析服务器响应"));
                    }
                } else {
                    reject(new Error(`TTS API 错误: ${response.status} ${response.statusText}`));
                }
            }).catch(error => {
                currentGenerations--;
                generationPromises.delete(cacheKey);
                reject(new Error(`无法连接到TTS服务器: ${error.message}`));
            });
        });

        generationPromises.set(cacheKey, generationPromise);
        return await generationPromise;
    }

    // 预加载下一个音频
    async function preloadNextAudio() {
        if (!preloadEnabled || playbackQueue.length < 2) return;

        const nextIndex = currentPlaybackIndex + 1;
        if (nextIndex >= playbackQueue.length) return;

        const nextTask = playbackQueue[nextIndex];
        if (nextTask && !nextTask.preloaded) {
            try {
                const blobUrl = await fetchAudioBlob(nextTask.url);
                nextTask.preloadedBlobUrl = blobUrl;
                nextTask.preloaded = true;
            } catch (error) {
                console.warn('预加载失败:', error);
            }
        }
    }

    // 获取音频Blob (使用 fetch)
    async function fetchAudioBlob(url) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const blob = await response.blob();
            return URL.createObjectURL(blob);
        } catch (error) {
            throw new Error('网络请求失败: ' + error.message);
        }
    }
    
    // 网络请求封装 (使用 fetch)
    async function makeRequest(url, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), options.timeout || 10000);
        
        try {
            const response = await fetch(url, {
                method: options.method || "GET",
                headers: options.headers || {},
                body: options.body || options.data, // 兼容 data 属性
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    // 检测语言
    function detectLanguage(text) {
        const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
        return japaneseRegex.test(text) ? "日语" : "中文";
    }

    // ... (getDialogueRegex, getDialogueSplitRegex, isDialogueFormat, extractDialogue 保持不变) ...
    function getDialogueRegex() {
        return quotationStyle === 'western' ? /"([^"]+?)"/g : /「([^」]+?)」/g;
    }

    function getDialogueSplitRegex() {
        return quotationStyle === 'western' ? /("[^"]*")/g : /(「[^」]*」)/g;
    }

    function isDialogueFormat(text) {
        if (quotationStyle === 'western') {
            return text.startsWith('"') && text.endsWith('"');
        } else {
            return text.startsWith('「') && text.endsWith('」');
        }
    }

    function extractDialogue(text) {
        const trimmed = text.trim();
        if (quotationStyle === 'western') {
            return trimmed.startsWith('"') && trimmed.endsWith('"') ?
                   trimmed.slice(1, -1).trim() : trimmed;
        } else {
            return trimmed.startsWith('「') && trimmed.endsWith('」') ?
                   trimmed.slice(1, -1).trim() : trimmed;
        }
    }

    // ... (UI 创建相关函数: createUI, createSettingsPanel, makeDraggable, etc. 完整移植) ...
    
    function createUI() {
        if (document.getElementById('tts-floating-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'tts-floating-panel';
        panel.className = `tts-panel ${edgeMode ? 'edge-mode' : ''}`;

        const mainControls = document.createElement('div');
        mainControls.className = 'tts-main-controls';

        // ... 按钮创建逻辑 ...
        // 这里省略具体的 DOM 创建代码，与原脚本一致，但需要确保图标正常显示
        // 原脚本使用 innerHTML 插入 icon，SillyTavern 中可能需要 FontAwesome 类
        // 原脚本直接使用字符图标 (▶, ⏹)，这对 ST 来说也是安全的

        const playBtn = document.createElement('button');
        playBtn.id = 'tts-play-btn';
        playBtn.className = 'tts-control-btn primary';
        playBtn.innerHTML = '<i class="icon">▶</i>';
        playBtn.title = '播放/暂停/继续';
        playBtn.addEventListener('click', handlePlayPauseResumeClick);

        const stopBtn = document.createElement('button');
        stopBtn.id = 'tts-stop-btn';
        stopBtn.className = 'tts-control-btn danger';
        stopBtn.innerHTML = '<i class="icon">⏹</i>';
        stopBtn.title = '停止播放';
        stopBtn.style.display = 'none';
        stopBtn.addEventListener('click', handleStopClick);

        const replayBtn = document.createElement('button');
        replayBtn.id = 'tts-replay-btn';
        replayBtn.className = 'tts-control-btn secondary';
        replayBtn.innerHTML = '<i class="icon">🔄</i>';
        replayBtn.title = '重播上一段';
        replayBtn.disabled = true;
        replayBtn.addEventListener('click', handleReplayClick);
        
        const reinferBtn = document.createElement('button');
        reinferBtn.id = 'tts-reinfer-btn';
        reinferBtn.className = 'tts-control-btn secondary';
        reinferBtn.innerHTML = '<i class="icon">⚡</i>';
        reinferBtn.title = '重新推理';
        reinferBtn.disabled = true;
        reinferBtn.addEventListener('click', handleReinferClick);

        const settingsBtn = document.createElement('button');
        settingsBtn.id = 'tts-settings-btn';
        settingsBtn.className = 'tts-control-btn settings';
        settingsBtn.innerHTML = '<i class="icon">⚙</i>';
        settingsBtn.title = '设置';
        settingsBtn.addEventListener('click', toggleSettingsPanel);

        const hideBtn = document.createElement('button');
        hideBtn.id = 'tts-hide-btn';
        hideBtn.className = 'tts-control-btn secondary';
        hideBtn.innerHTML = '<i class="icon">👁</i>';
        hideBtn.title = '边缘隐藏';
        hideBtn.addEventListener('click', toggleEdgeHide);

        mainControls.appendChild(playBtn);
        mainControls.appendChild(stopBtn);
        mainControls.appendChild(replayBtn);
        mainControls.appendChild(reinferBtn);
        mainControls.appendChild(settingsBtn);
        mainControls.appendChild(hideBtn);

        // 单角色选择器逻辑保持一致
        const singleCharContainer = document.createElement('div');
        singleCharContainer.id = 'tts-single-char-container';
        singleCharContainer.style.cssText = `width: 100%; padding: 8px; margin-top: 8px; display: ${isSingleCharacterMode && (detectionMode === 'character_and_dialogue' || detectionMode === 'character_emotion_and_dialogue') ? 'block' : 'none'};`;

        const charSelectBtn = document.createElement('button');
        charSelectBtn.id = 'tts-single-char-select-btn';
        charSelectBtn.className = 'tts-control-btn secondary';
        charSelectBtn.style.cssText = 'width: 100%; padding: 8px 12px; font-size: 12px;';
        charSelectBtn.innerHTML = `<i class="icon">👤</i><span class="text">${singleCharacterTarget || '全部角色'}</span>`;
        charSelectBtn.title = '点击选择角色';
        
        charSelectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showSingleCharacterSelector(e.target);
        });

        singleCharContainer.appendChild(charSelectBtn);
        mainControls.appendChild(singleCharContainer);

        panel.appendChild(mainControls);

        if (edgeMode) {
            panel.classList.add('edge-mode');
            panel.addEventListener('mouseenter', () => {
                panel.classList.add('expanded');
            });
            panel.addEventListener('mouseleave', () => {
                panel.classList.remove('expanded');
            });
        }

        document.body.appendChild(panel);
        makeDraggable(panel);
    }
    
    // ... (makeDraggable, toggleSettingsPanel, createSettingsPanel 等函数逻辑保持一致) ...
    // 注意：createSettingsPanel 中的 innerHTML 需要保持一致，事件绑定也要保持一致
    // 由于篇幅限制，我这里不重复粘贴所有 UI 代码，但在实际文件中需要完整包含
    
    // 辅助函数：显示通知 (适配 SillyTavern)
    function showNotification(message, type = 'info', duration = 3000) {
        if (window.toastr) {
            window.toastr[type === 'error' ? 'error' : (type === 'warning' ? 'warning' : 'success')](message);
        } else {
            // 降级方案
            const container = document.getElementById('tts-notification-container') || createNotificationContainer();
            const notification = document.createElement('div');
            notification.className = `tts-notification ${type}`;
            notification.textContent = message;
            container.appendChild(notification);
            setTimeout(() => notification.classList.add('show'), 100);
            setTimeout(() => {
                notification.classList.remove('show');
                setTimeout(() => notification.remove(), 300);
            }, duration);
        }
    }

    function createNotificationContainer() {
        const container = document.createElement('div');
        container.id = 'tts-notification-container';
        document.body.appendChild(container);
        return container;
    }

    // ... (reparseCurrentMessage, observeChat 等核心逻辑) ...
    
    function observeChat() {
        // 使用 SillyTavern 的事件系统可能更好，但为了兼容油猴脚本的复杂逻辑，
        // 我们保留 MutationObserver 监听 #chat 容器
        const validDialogueRegex = /[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff]/;
        let debounceTimer;

        const observerCallback = (mutations, observer) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                const chatContainer = document.querySelector('#chat');
                if (!chatContainer) return;
                
                // 找到最后一条AI消息
                const messages = Array.from(chatContainer.querySelectorAll('.mes[is_user="false"]'));
                if (messages.length === 0) return;
                const lastMessageElement = messages[messages.length - 1];
                const messageTextElement = lastMessageElement.querySelector('.mes_text');
                if (!messageTextElement) return;

                const messageId = lastMessageElement.getAttribute('mesid') || lastMessageElement.innerText.substring(0, 50);
                const fullText = messageTextElement.innerText;

                if (lastProcessedMessageId === messageId && lastProcessedText === fullText) return;
                
                lastProcessedMessageId = messageId;
                lastProcessedText = fullText;

                // 这里调用 reparseCurrentMessage 或类似的逻辑
                // 为了简化，我们直接调用 reparseCurrentMessage()
                // 但需要注意 reparseCurrentMessage 内部是重新查询 DOM 的
                // 我们可以稍微改造 reparseCurrentMessage 接受元素，或者保持原样
                reparseCurrentMessage();
                
                // 自动播放逻辑
                 if (autoPlayEnabled && lastMessageParts.length > 0 && !isPlaying) {
                    if (autoPlayTimeout) clearTimeout(autoPlayTimeout);
                    autoPlayTimeout = setTimeout(() => {
                        if (!isPlaying && lastProcessedMessageId === messageId) {
                            handlePlayPauseResumeClick();
                        }
                    }, 800);
                }

            }, 300);
        };

        const observer = new MutationObserver(observerCallback);
        
        // 等待 #chat 出现
        const checkChatInterval = setInterval(() => {
            const chatContainer = document.querySelector('#chat');
            if (chatContainer) {
                observer.observe(chatContainer, { 
                    childList: true, 
                    subtree: true, 
                    characterData: true 
                });
                clearInterval(checkChatInterval);
                // 初始触发一次
                reparseCurrentMessage();
            }
        }, 1000);
    }
    
    // ... (其他缺失的函数定义: reparseCurrentMessage, handlePlayPauseResumeClick, etc.) ...
    // 必须包含所有原来油猴脚本定义的函数，否则会报错

    // 为了确保 index.js 完整可用，我需要将缺失的函数补全。
    // 这里我将使用一种策略：将油猴脚本的函数体复制过来，做少量修改。
    
    // ... (复制 updateSettingsVisibility, populateVoiceSelects, updateEmotionSelect, renderCharacterVoices, etc.) ...
    
    // 获取TTS模型列表
    async function fetchTTSModels() {
        try {
            const response = await makeRequest(TTS_API_ENDPOINT_MODELS, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ version: ttsApiVersion })
            });

            if (response.ok) {
                const data = await response.json();
                ttsModelsWithDetails = data.models || {};
                ttsModels = Object.keys(ttsModelsWithDetails);

                if (ttsModels.length > 0 && !defaultVoice) {
                    defaultVoice = ttsModels[0];
                    Settings.save();
                }
                populateVoiceSelects();
                updateEmotionSelect(defaultVoice);
                showNotification(`成功加载 ${ttsModels.length} 个语音模型`, 'success');
            } else {
                throw new Error(`服务器返回错误状态: ${response.status}`);
            }
        } catch (error) {
            console.error("获取TTS模型失败:", error);
            showNotification(`获取语音模型失败: ${error.message}`, 'error');
        }
    }

    // 初始化
    $(document).ready(async function () {
        // 加载扩展设置界面
        function loadExtensionSettings() {
             // 按照 Extension 编写指南
            const settingsHtmlUrl = `scripts/extensions/ST-GPT-SoVITS-Extension/settings.html`;
            $.get(settingsHtmlUrl, function (data) {
                $("#extensions_settings2").html(data);
                
                // 绑定重置按钮事件
                $("#st-gpt-sovits-reset-ui").off('click').on('click', function() {
                    const panel = document.getElementById('tts-floating-panel');
                    if (panel) {
                        panel.style.left = '50%';
                        panel.style.top = '50%';
                        panel.style.transform = 'translate(-50%, -50%)';
                        panel.classList.remove('edge-hidden');
                        showNotification('悬浮窗位置已重置');
                    } else {
                        createUI();
                        showNotification('悬浮窗已重新创建');
                    }
                });
            });
        }

        // 在扩展列表中添加点击事件
        // SillyTavern 会自动创建列表项，点击时会加载 settings.html 到 #extensions_settings2
        // 我们需要监听点击事件或者利用 ST 的机制
        // 通常扩展只需要提供 settings.html，ST 会自动处理加载
        // 但我们需要在加载后绑定 JS 事件。
        // 可以监听 extension_settings_opened 事件或者轮询
        
        // 这里我们简单地挂载一个全局函数供 settings.html 中的 onclick 调用 (如果需要)
        // 或者使用 MutationObserver 监听 #extensions_settings2 的内容变化
        
        const settingsObserver = new MutationObserver((mutations) => {
            if (document.getElementById('st-gpt-sovits-reset-ui')) {
                $("#st-gpt-sovits-reset-ui").off('click').on('click', function() {
                     const panel = document.getElementById('tts-floating-panel');
                     if (panel) {
                         panel.style.left = 'auto';
                         panel.style.top = '20%';
                         panel.style.right = '20px';
                         panel.style.transform = 'none';
                         panel.classList.remove('edge-hidden', 'edge-mode');
                         showNotification('悬浮窗位置已重置');
                     } else {
                         createUI();
                     }
                });
            }
        });
        settingsObserver.observe(document.getElementById('extensions_settings2'), { childList: true, subtree: true });

        // 加载设置
        Settings.load();

        // 尝试连接 TTS 服务
        try {
            await fetchTTSModels();
        } catch (e) {
            console.warn("TTS初始化连接失败", e);
        }

        // 创建 UI
        createUI();
        
        // 开始监听聊天
        observeChat();
        
        console.log(`${EXTENSION_NAME} loaded.`);
    });

    // ==================================================================================
    // 以下是必须保留的辅助函数和事件处理函数，从油猴脚本移植而来
    // 为了确保功能完整性，必须包含这些
    // ==================================================================================
    
    // ... (这里需要把 reparseCurrentMessage, handlePlayPauseResumeClick, handleStopClick, handleReplayClick, toggleSettingsPanel, createSettingsPanel, makeDraggable, toggleEdgeHide, showSingleCharacterSelector 等函数全部放进来) ...
    // 由于篇幅，我将在实际写入文件时填充这些内容。
    
    // 占位符：后续将通过 replace_in_file 或直接写入完整内容来完成。
    // 鉴于这是一次性生成，我必须在这里写全。
    
    // 重新解析当前消息
    async function reparseCurrentMessage() {
        if (frontendAdaptationEnabled) {
            const result = await forceDetectCurrentMessageAdapted();
            const playButton = document.getElementById('tts-play-btn');
            if (playButton) {
                playButton.disabled = !result.success || result.totalParts === 0;
            }
            return;
        }

        const chatContainer = document.querySelector('#chat');
        if (!chatContainer) return;
        const messages = chatContainer.querySelectorAll('.mes[is_user="false"]');
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
                const character = match[1].trim();
                const dialogue = match[2].trim();
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
                const character = match[1].trim();
                const emotion = match[2].trim();
                const dialogue = match[3].trim();
                if (dialogue && validDialogueRegex.test(dialogue)) {
                    currentMessageParts.push({ type: 'character_emotion_dialogue', character, emotion, dialogue });
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
                const trimmedSegment = segment.trim();
                if (!trimmedSegment) continue;

                if (isDialogueFormat(trimmedSegment)) {
                    const dialogue = extractDialogue(trimmedSegment);
                    if (dialogue && validDialogueRegex.test(dialogue)) {
                        currentMessageParts.push({ type: 'dialogue', dialogue });
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
                }
            }
            if (allDialogues.length > 0) {
                currentMessageParts.push({ type: 'dialogue_only', dialogue: allDialogues.join('\n') });
            }
        } else if (detectionMode === 'entire_message') {
            const trimmedText = fullText.trim();
            if (trimmedText) {
                currentMessageParts.push({ type: 'entire_message', dialogue: trimmedText });
            }
        } else if (detectionMode === 'emotion_and_dialogue') {
            const regex = /〈([^〉]+)〉\s*「([^」]+?)」/gs;
            let match;
            while ((match = regex.exec(fullText)) !== null) {
                const emotion = match[1].trim();
                const dialogue = match[2].trim();
                if (dialogue && validDialogueRegex.test(dialogue)) {
                    currentMessageParts.push({ type: 'emotion_dialogue', emotion, dialogue });
                }
            }
        }

        if (hasNewCharacter) {
            Settings.save();
        }

        const playButton = document.getElementById('tts-play-btn');
        if (!isPlaying) {
            lastMessageParts = currentMessageParts;
            if (playButton) playButton.disabled = currentMessageParts.length === 0;
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

            const onEnded = () => {
                cleanup();
                resolve();
            };
            const onError = (e) => {
                cleanup();
                if (isPlaying) {
                    reject(new Error("音频播放失败"));
                }
            };
            const cleanup = () => {
                URL.revokeObjectURL(blobUrl);
                if (currentAudio) {
                    currentAudio.removeEventListener('ended', onEnded);
                    currentAudio.removeEventListener('error', onError);
                }
            };

            currentAudio.addEventListener('ended', onEnded);
            currentAudio.addEventListener('error', onError);

            currentAudio.src = blobUrl;
            currentAudio.play().catch(onError);
        });
    }

    // 处理播放/暂停/继续点击
    function handlePlayPauseResumeClick() {
        const playButton = document.getElementById('tts-play-btn');

        if (isPlaying && !isPaused) {
            isPaused = true;
            if (currentAudio) currentAudio.pause();
            updatePlayButton('▶', '继续');
            return;
        }

        if (isPlaying && isPaused) {
            isPaused = false;
            updatePlayButton('⏸', '暂停');
            if (currentAudio) {
                currentAudio.play();
            } else {
                processPlaybackQueue();
            }
            return;
        }

        if (ttsModels.length === 0) {
            showNotification("播放失败：无法连接到TTS服务或未找到任何语音模型。", 'error');
            return;
        }

        if (lastMessageParts.length === 0) {
            showNotification("未找到符合当前识别模式的文本。", 'warning');
            return;
        }

        const tasksToGenerate = lastMessageParts.map(part => {
            if (isSingleCharacterMode && singleCharacterTarget && part.character && part.character !== singleCharacterTarget) {
                return null;
            }

            let voice = '';
            let version = ttsApiVersion;
            let taskEmotion = null;
            let voiceSetting;

            switch (part.type) {
                case 'character_emotion_dialogue':
                    voiceSetting = characterVoices[part.character];
                    if (typeof voiceSetting === 'object') {
                        voice = voiceSetting.voice || defaultVoice;
                        version = voiceSetting.version || ttsApiVersion;
                    } else {
                        voice = voiceSetting || defaultVoice;
                    }
                    taskEmotion = part.emotion;
                    break;
                case 'emotion_dialogue':
                    voice = dialogueVoice || defaultVoice;
                    taskEmotion = part.emotion;
                    break;
                case 'character_dialogue':
                    voiceSetting = characterVoices[part.character];
                    if (typeof voiceSetting === 'object') {
                        voice = voiceSetting.voice || defaultVoice;
                        version = voiceSetting.version || ttsApiVersion;
                    } else {
                        voice = voiceSetting || defaultVoice;
                    }
                    break;
                case 'narration':
                    voice = narrationVoice || defaultVoice;
                    break;
                case 'dialogue':
                    voice = dialogueVoice || defaultVoice;
                    break;
                case 'dialogue_only':
                case 'entire_message':
                    voice = defaultVoice;
                    break;
            }
            if (voice && voice !== DO_NOT_PLAY_VALUE) {
                return { dialogue: part.dialogue, voice: voice, version: version, emotion: taskEmotion, character: part.character };
            }
            return null;
        }).filter(Boolean);

        if (tasksToGenerate.length === 0) {
            showNotification("没有需要播放的对话内容（请检查语音配置）。", 'warning');
            return;
        }

        isPlaying = true;
        isPaused = false;
        generationQueue = [...tasksToGenerate];
        playbackQueue = [];
        currentPlaybackIndex = 0;
        document.getElementById('tts-stop-btn').style.display = 'inline-block';
        document.getElementById('tts-replay-btn').disabled = true;
        document.getElementById('tts-reinfer-btn').disabled = true;

        processGenerationQueue();
    }

    // 处理停止点击
    function handleStopClick() {
        isPlaying = false;
        isPaused = false;
        generationQueue = [];
        playbackQueue = [];

        isProcessingQueue = false;
        currentPlaybackIndex = 0;
        playbackSequenceId++;

        if (autoPlayTimeout) {
            clearTimeout(autoPlayTimeout);
            autoPlayTimeout = null;
        }

        if (currentAudio) {
            currentAudio.pause();
            currentAudio.src = '';
            currentAudio = null;
        }

        updatePlayButton('▶', '播放');
        document.getElementById('tts-play-btn').disabled = lastMessageParts.length === 0;
        document.getElementById('tts-stop-btn').style.display = 'none';
        document.getElementById('tts-replay-btn').disabled = lastPlayedQueue.length === 0;
        document.getElementById('tts-reinfer-btn').disabled = lastPlayedQueue.length === 0;
    }

    // 处理重播点击
    function handleReplayClick() {
        if (lastPlayedQueue.length === 0 || isPlaying) return;
        handleStopClick();
        playbackQueue = [...lastPlayedQueue];
        currentPlaybackIndex = 0;
        isPlaying = true;
        isPaused = false;
        updatePlayButton('⏸', '暂停');
        document.getElementById('tts-stop-btn').style.display = 'inline-block';
        document.getElementById('tts-replay-btn').disabled = true;
        document.getElementById('tts-reinfer-btn').disabled = true;
        processPlaybackQueue();
    }

    // 处理重新推理点击
    function handleReinferClick() {
        if (isPlaying) {
             showNotification("正在播放中，请先停止。", 'info');
             return;
        }
        if (lastMessageParts.length === 0) {
            showNotification("没有可重新推理的内容。", 'warning');
            return;
        }
        if (ttsModels.length === 0) {
            showNotification("重新推理失败：无法连接到TTS服务或未找到任何语音模型。", 'error');
            return;
        }
        const tasksToGenerate = lastMessageParts.map(part => {
            if (isSingleCharacterMode && singleCharacterTarget && part.character && part.character !== singleCharacterTarget) {
                return null;
            }

            let voice = '';
            let version = ttsApiVersion;
            let taskEmotion = null;
            let voiceSetting;

            switch (part.type) {
                case 'character_emotion_dialogue':
                    voiceSetting = characterVoices[part.character];
                    if (typeof voiceSetting === 'object') {
                        voice = voiceSetting.voice || defaultVoice;
                        version = voiceSetting.version || ttsApiVersion;
                    } else {
                        voice = voiceSetting || defaultVoice;
                    }
                    taskEmotion = part.emotion;
                    break;
                case 'emotion_dialogue':
                    voice = dialogueVoice || defaultVoice;
                    taskEmotion = part.emotion;
                    break;
                case 'character_dialogue':
                    voiceSetting = characterVoices[part.character];
                    if (typeof voiceSetting === 'object') {
                        voice = voiceSetting.voice || defaultVoice;
                        version = voiceSetting.version || ttsApiVersion;
                    } else {
                        voice = voiceSetting || defaultVoice;
                    }
                    break;
                case 'narration':
                    voice = narrationVoice || defaultVoice;
                    break;
                case 'dialogue':
                    voice = dialogueVoice || defaultVoice;
                    break;
                case 'dialogue_only':
                case 'entire_message':
                    voice = defaultVoice;
                    break;
            }
            if (voice && voice !== DO_NOT_PLAY_VALUE) {
                return { dialogue: part.dialogue, voice: voice, version: version, emotion: taskEmotion, character: part.character, bypassCache: true };
            }
            return null;
        }).filter(Boolean);
        if (tasksToGenerate.length === 0) {
            showNotification("没有需要播放的对话内容（请检查语音配置）。", 'warning');
            return;
        }
        isPlaying = true;
        isPaused = false;
        generationQueue = [...tasksToGenerate];
        playbackQueue = [];
        currentPlaybackIndex = 0;
        document.getElementById('tts-stop-btn').style.display = 'inline-block';
        document.getElementById('tts-replay-btn').disabled = true;
        document.getElementById('tts-reinfer-btn').disabled = true;
        processGenerationQueue();
    }
    
    // 更新播放按钮
    function updatePlayButton(icon, text) {
        const playButton = document.getElementById('tts-play-btn');
        if (playButton) {
            playButton.innerHTML = `<i class="icon">${icon}</i><span class="text">${text}</span>`;
        }
    }

    // 处理生成队列
    async function processGenerationQueue() {
        if (!isPlaying) return;

        if (generationQueue.length > 0) {
            updatePlayButton('⏳', '生成中...');
            document.getElementById('tts-play-btn').disabled = true;

            try {
                const results = await generateAudioSequentially(generationQueue);
                playbackQueue.push(...results);
                generationQueue = [];
            } catch (error) {
                console.error('音频生成失败:', error);
                showNotification('音频生成失败，请检查TTS服务控制台以了解详情。', 'error');
                handleStopClick();
                return;
            }

            if (playbackQueue.length === 0) {
                showNotification('所有对话都生成失败，请检查TTS服务控制台以了解详情。', 'error');
                handleStopClick();
                return;
            }

            lastPlayedQueue = [...playbackQueue];
            document.getElementById('tts-play-btn').disabled = false;
            document.getElementById('tts-replay-btn').disabled = false;
            document.getElementById('tts-reinfer-btn').disabled = false;
            updatePlayButton('⏸', '暂停');

            processPlaybackQueue();
        }
    }

    // 处理播放队列
    async function processPlaybackQueue() {
        if (isProcessingQueue) return;

        if (isPaused) return;
        if (playbackQueue.length === 0 || !isPlaying) {
            if (isPlaying) handleStopClick();
            return;
        }

        if (currentPlaybackIndex >= playbackQueue.length) {
            if (isPlaying) handleStopClick();
            return;
        }

        isProcessingQueue = true;
        const currentSequenceId = ++playbackSequenceId;

        try {
            const task = playbackQueue[currentPlaybackIndex];
            if (!task) return;

            let blobUrl;

            if (task.preloadedBlobUrl) {
                blobUrl = task.preloadedBlobUrl;
                task.preloadedBlobUrl = null;
            } else {
                blobUrl = await fetchAudioBlob(task.url);
            }

            preloadNextAudio();

            await playAudio(blobUrl);

            if (currentSequenceId === playbackSequenceId && !isPaused) {
                currentPlaybackIndex++;
                setTimeout(() => {
                    isProcessingQueue = false;
                    processPlaybackQueue();
                }, 100);
            } else {
                isProcessingQueue = false;
            }
        } catch (error) {
            if (isPlaying) {
                showNotification(`播放失败: ${error.message}`, 'error');
                handleStopClick();
            }
            isProcessingQueue = false;
        }
    }
    
    // 切换设置面板
    function toggleSettingsPanel() {
        const existingPanel = document.getElementById('tts-settings-modal');
        if (existingPanel) {
            existingPanel.remove();
            return;
        }
        createSettingsPanel();
    }

    // 创建设置面板
    function createSettingsPanel() {
        const modal = document.createElement('div');
        modal.id = 'tts-settings-modal';
        modal.className = 'tts-modal';

        const modalContent = document.createElement('div');
        modalContent.className = 'tts-modal-content';

        const header = document.createElement('div');
        header.className = 'tts-modal-header';
        header.innerHTML = `
            <h2>GPT-SoVITS 设置</h2>
            <div class="header-buttons">
                <button id="console-logger-btn" class="tts-header-btn" title="查看控制台日志"><i class="icon">📋</i></button>
                <button id="diagnostic-btn-header" class="tts-header-btn" title="网络诊断"><i class="icon">🔍</i></button>
                <button class="tts-close-btn">×</button>
            </div>
        `;

        const body = document.createElement('div');
        body.className = 'tts-modal-body';

        body.innerHTML = `
            <div class="tts-setting-section">
                <h3><i class="icon">🔧</i> 基础设置</h3>

                <div class="tts-setting-item">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <label>播放模式状态</label>
                        <span class="version-badge">v1.0.0</span>
                    </div>
                    <div id="settings-status-indicator" class="tts-status-indicator" style="margin-top: 8px;">
                        <div class="status-dot ${autoPlayEnabled ? 'active' : ''}"></div>
                        <span class="status-text">${autoPlayEnabled ? '自动播放模式' : '手动播放模式'}</span>
                    </div>
                </div>

                <div class="tts-setting-item">
                    <label>TTS API 服务器地址</label>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <input type="text" id="api-base-url" value="${ttsApiBaseUrl}" placeholder="http://127.0.0.1:8000" style="flex: 1;">
                        <button id="test-connection-btn" class="tts-test-btn">测试连接</button>
                    </div>
                    <p class="tts-setting-desc">填入你的TTS服务器地址，格式：http://IP:端口</p>
                </div>

                <div class="tts-setting-item">
                    <label>TTS API 版本</label>
                    <select id="api-version">
                        ${['v2', 'v2Pro', 'v2ProPlus', 'v3', 'v4'].map(v => `<option value="${v}" ${ttsApiVersion === v ? 'selected' : ''}>${v}</option>`).join('')}
                    </select>
                </div>

                <div class="tts-setting-item">
                    <label>识别模式</label>
                    <div class="tts-radio-group">
                        <label class="tts-radio-item">
                            <input type="radio" name="detection_mode" value="character_and_dialogue" ${detectionMode === 'character_and_dialogue' ? 'checked' : ''}>
                            <span>【角色】「对话」</span>
                        </label>
                        <label class="tts-radio-item">
                            <input type="radio" name="detection_mode" value="character_emotion_and_dialogue" ${detectionMode === 'character_emotion_and_dialogue' ? 'checked' : ''}>
                            <span>【角色】〈情绪〉「对话」</span>
                        </label>
                        <label class="tts-radio-item">
                            <input type="radio" name="detection_mode" value="emotion_and_dialogue" ${detectionMode === 'emotion_and_dialogue' ? 'checked' : ''}>
                            <span>〈情绪〉「对话」</span>
                        </label>
                        <label class="tts-radio-item">
                            <input type="radio" name="detection_mode" value="narration_and_dialogue" ${detectionMode === 'narration_and_dialogue' ? 'checked' : ''}>
                            <span>旁白与对话</span>
                        </label>
                        <label class="tts-radio-item">
                            <input type="radio" name="detection_mode" value="dialogue_only" ${detectionMode === 'dialogue_only' ? 'checked' : ''}>
                            <span>仅「对话」</span>
                        </label>
                        <label class="tts-radio-item">
                            <input type="radio" name="detection_mode" value="entire_message" ${detectionMode === 'entire_message' ? 'checked' : ''}>
                            <span>朗读整段</span>
                        </label>
                    </div>
                </div>

                <div class="tts-setting-item">
                    <label>引号样式</label>
                    <div class="tts-toggle-group">
                        <label class="tts-toggle-item ${quotationStyle === 'japanese' ? 'active' : ''}">
                            <input type="radio" name="quotation_style" value="japanese" ${quotationStyle === 'japanese' ? 'checked' : ''}>
                            <span>「日式引号」</span>
                        </label>
                        <label class="tts-toggle-item ${quotationStyle === 'western' ? 'active' : ''}">
                            <input type="radio" name="quotation_style" value="western" ${quotationStyle === 'western' ? 'checked' : ''}>
                            <span>"西式引号"</span>
                        </label>
                    </div>
                </div>

                <div class="tts-setting-item" id="single-char-mode-setting" style="display: none;">
                    <label class="tts-switch-label">
                        <input type="checkbox" id="single-char-mode-toggle" ${isSingleCharacterMode ? 'checked' : ''}>
                        <span class="tts-switch-slider"></span>
                        启用单角色模式
                    </label>
                    <p class="tts-setting-desc">启用后，主悬浮窗会显示角色选择器</p>
                </div>

                <div class="tts-setting-item">
                    <label>前端美化适配</label>
                    <div class="tts-switch-container">
                         <label class="tts-switch-label">
                            <input type="checkbox" id="frontend-adaptation-toggle" ${frontendAdaptationEnabled ? 'checked' : ''}>
                            <span class="tts-switch-slider"></span>
                             <span class="tts-switch-text">${frontendAdaptationEnabled ? '已启用' : '已禁用'}</span>
                        </label>
                    </div>
                    <p class="tts-setting-desc">启用后支持从美化的前端界面（如juus本体.html）中提取文本</p>
                </div>
            </div>

            <div class="tts-setting-section">
                <h3><i class="icon">🎮</i> 功能设置</h3>

                <div class="tts-setting-item">
                    <label class="tts-switch-label">
                        <input type="checkbox" id="auto-play-toggle" ${autoPlayEnabled ? 'checked' : ''}>
                        <span class="tts-switch-slider"></span>
                        自动播放新消息
                    </label>
                    <p class="tts-setting-desc">启用后，新消息到达时会自动开始播放</p>
                </div>

                <div class="tts-setting-item">
                    <label class="tts-switch-label">
                        <input type="checkbox" id="edge-mode-toggle" ${edgeMode ? 'checked' : ''}>
                        <span class="tts-switch-slider"></span>
                        边缘依附模式
                    </label>
                    <p class="tts-setting-desc">启用后，工具栏会依附到屏幕边缘</p>
                </div>
                
                 <div class="tts-setting-item">
                    <label>重新检测消息</label>
                    <button id="big-menu-detect-btn" class="tts-test-btn" style="width: 100%; margin-top: 8px;">
                        <i class="icon">🔍</i> 重新检测当前消息
                    </button>
                </div>
            </div>

            <div class="tts-setting-section">
                <h3><i class="icon">🎤</i> 语音配置</h3>

                <div class="tts-setting-item" id="default-voice-setting">
                    <label>默认语音</label>
                    <select id="default-voice-select">
                        <option value="">» 选择语音模型 «</option>
                        <option value="${DO_NOT_PLAY_VALUE}">🔇 不播放</option>
                    </select>
                </div>

                <div class="tts-setting-item" id="narration-voice-setting" style="display: none;">
                    <label>旁白音色</label>
                    <select id="narration-voice-select">
                        <option value="">» 使用默认 «</option>
                    </select>
                </div>

                <div class="tts-setting-item" id="dialogue-voice-setting" style="display: none;">
                    <label>对话音色</label>
                    <select id="dialogue-voice-select">
                        <option value="">» 使用默认 «</option>
                    </select>
                </div>

                <div class="tts-setting-item">
                    <label>感情</label>
                    <select id="emotion-select">
                        <option value="默认">默认</option>
                    </select>
                </div>

                <div class="tts-setting-item" id="global-speed-setting">
                    <label>全局语速: <span id="speed-value">${speedFacter}</span></label>
                    <input type="range" id="speed-slider" min="0.5" max="2.0" step="0.01" value="${speedFacter}">
                </div>
            </div>

            <div class="tts-setting-section" id="character-groups-section" style="display: none;">
                <h3><i class="icon">🏷️</i> 角色分组管理</h3>
                <div class="tts-setting-item">
                    <div class="tts-group-controls">
                        <input type="text" id="new-group-name" placeholder="输入分组名称" maxlength="20">
                        <input type="color" id="new-group-color" value="#667eea" title="选择分组颜色">
                        <button id="add-group-btn" class="tts-add-group-btn">创建分组</button>
                    </div>
                </div>
                <div id="character-groups-container">
                    <p class="tts-empty-state">暂无分组，请先创建分组</p>
                </div>
            </div>

            <div class="tts-setting-section" id="character-voices-section" style="display: none;">
                <h3><i class="icon">👥</i> 角色语音配置</h3>
                <div id="character-voices-container">
                    <p class="tts-empty-state">暂无检测到的角色</p>
                </div>
            </div>
        `;

        modalContent.appendChild(header);
        modalContent.appendChild(body);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        bindSettingsEvents();
        updateSettingsVisibility();
        populateVoiceSelects();
        renderCharacterVoices();
        renderCharacterGroups();

        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });

        header.querySelector('.tts-close-btn').addEventListener('click', () => modal.remove());
        header.querySelector('#console-logger-btn').addEventListener('click', () => showConsoleLogger());
        header.querySelector('#diagnostic-btn-header').addEventListener('click', () => runDiagnostic());
    }

    // 绑定设置事件
    function bindSettingsEvents() {
        document.getElementById('api-base-url').addEventListener('change', (e) => {
            let newUrl = e.target.value.trim();
            if (newUrl.endsWith('/')) newUrl = newUrl.slice(0, -1);
            if (newUrl && !newUrl.match(/^https?:\/\/.+/)) {
                showNotification('请输入有效的URL格式', 'error');
                e.target.value = ttsApiBaseUrl;
                return;
            }
            ttsApiBaseUrl = newUrl || 'http://127.0.0.1:8000';
            updateApiEndpoints();
            Settings.save();
            showNotification('API地址已更新', 'success');
        });

        document.getElementById('test-connection-btn').addEventListener('click', async () => {
            const btn = document.getElementById('test-connection-btn');
            const originalText = btn.textContent;
            btn.textContent = '测试中...';
            btn.disabled = true;

            try {
                const urlInput = document.getElementById('api-base-url');
                let newUrl = urlInput.value.trim();
                if (newUrl.endsWith('/')) newUrl = newUrl.slice(0, -1);
                
                ttsApiBaseUrl = newUrl || 'http://127.0.0.1:8000';
                updateApiEndpoints();

                // 简单的连接测试
                const response = await fetch(`${ttsApiBaseUrl}/`);
                if (response.ok || response.status === 404) { // 404意味着服务器在运行
                     showNotification('连接测试成功！', 'success');
                     Settings.save();
                } else {
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (error) {
                showNotification(`连接测试失败：${error.message}`, 'error');
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        });

        document.getElementById('api-version').addEventListener('change', (e) => {
            ttsApiVersion = e.target.value.trim();
            Settings.save();
            fetchTTSModels();
        });

        document.querySelectorAll('input[name="detection_mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                detectionMode = e.target.value;
                Settings.save();
                updateSettingsVisibility();
                lastMessageParts = [];
                lastProcessedMessageId = null;
                reparseCurrentMessage();
            });
        });
        
        document.querySelectorAll('input[name="quotation_style"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                quotationStyle = e.target.value;
                Settings.save();
                document.querySelectorAll('.tts-toggle-item').forEach(item => {
                    item.classList.remove('active');
                });
                e.target.closest('.tts-toggle-item').classList.add('active');
            });
        });
        
        const singleCharToggle = document.getElementById('single-char-mode-toggle');
        if (singleCharToggle) {
            singleCharToggle.addEventListener('change', (e) => {
                isSingleCharacterMode = e.target.checked;
                Settings.save();
                updateSingleCharacterSelector();
                lastMessageParts = [];
                lastProcessedMessageId = null;
                reparseCurrentMessage();
                showNotification(isSingleCharacterMode ? '单角色模式已启用' : '单角色模式已禁用', 'success');
            });
        }

        document.getElementById('frontend-adaptation-toggle').addEventListener('change', (e) => {
            frontendAdaptationEnabled = e.target.checked;
            Settings.save();
            const switchText = e.target.parentElement.querySelector('.tts-switch-text');
            if (switchText) switchText.textContent = frontendAdaptationEnabled ? '已启用' : '已禁用';
            reparseCurrentMessage();
        });

        document.getElementById('auto-play-toggle').addEventListener('change', (e) => {
            autoPlayEnabled = e.target.checked;
            Settings.save();
            updateStatusIndicator();
        });

        document.getElementById('edge-mode-toggle').addEventListener('change', (e) => {
            edgeMode = e.target.checked;
            Settings.save();
            updateEdgeMode();
        });
        
        document.getElementById('big-menu-detect-btn').addEventListener('click', async () => {
             await handleFrontendDetectClick();
        });

        document.getElementById('default-voice-select').addEventListener('change', (e) => {
            defaultVoice = e.target.value;
            Settings.save();
            updateEmotionSelect(defaultVoice);
        });

        document.getElementById('narration-voice-select').addEventListener('change', (e) => {
            narrationVoice = e.target.value;
            Settings.save();
            updateEmotionSelect(narrationVoice || defaultVoice);
        });

        document.getElementById('dialogue-voice-select').addEventListener('change', (e) => {
            dialogueVoice = e.target.value;
            Settings.save();
            updateEmotionSelect(dialogueVoice || defaultVoice);
        });

        document.getElementById('emotion-select').addEventListener('change', (e) => {
            emotion = e.target.value;
            Settings.save();
        });

        const speedSlider = document.getElementById('speed-slider');
        const speedValue = document.getElementById('speed-value');
        speedSlider.addEventListener('input', (e) => {
            speedValue.textContent = e.target.value;
        });
        speedSlider.addEventListener('change', (e) => {
            speedFacter = parseFloat(e.target.value);
            Settings.save();
        });
        
        const addGroupBtn = document.getElementById('add-group-btn');
        if (addGroupBtn) {
            addGroupBtn.addEventListener('click', () => {
                const nameInput = document.getElementById('new-group-name');
                const colorInput = document.getElementById('new-group-color');
                const groupName = nameInput.value.trim();
                if (!groupName) return showNotification('请输入分组名称', 'warning');
                if (characterGroups[groupName]) return showNotification('分组名称已存在', 'warning');

                characterGroups[groupName] = { characters: [], color: colorInput.value };
                Settings.save();
                renderCharacterGroups();
                nameInput.value = '';
                showNotification(`分组 "${groupName}" 创建成功`, 'success');
            });
        }
    }

    function updateSettingsVisibility() {
        const narrationSetting = document.getElementById('narration-voice-setting');
        const dialogueSetting = document.getElementById('dialogue-voice-setting');
        const characterSection = document.getElementById('character-voices-section');
        const characterGroupsSection = document.getElementById('character-groups-section');
        const defaultSetting = document.getElementById('default-voice-setting');
        const globalSpeedSetting = document.getElementById('global-speed-setting');
        const singleCharModeSetting = document.getElementById('single-char-mode-setting');

        if (narrationSetting && dialogueSetting && characterSection && defaultSetting && characterGroupsSection) {
            if (detectionMode === 'narration_and_dialogue') {
                narrationSetting.style.display = 'block';
                dialogueSetting.style.display = 'block';
                characterSection.style.display = 'none';
                characterGroupsSection.style.display = 'none';
                defaultSetting.style.display = 'none';
                globalSpeedSetting.style.display = 'block';
                singleCharModeSetting.style.display = 'none';
            } else if (detectionMode === 'character_and_dialogue' || detectionMode === 'character_emotion_and_dialogue') {
                narrationSetting.style.display = 'none';
                dialogueSetting.style.display = 'none';
                characterSection.style.display = 'block';
                characterGroupsSection.style.display = 'block';
                defaultSetting.style.display = 'block';
                globalSpeedSetting.style.display = 'none';
                singleCharModeSetting.style.display = 'block';
            } else if (detectionMode === 'emotion_and_dialogue') {
                narrationSetting.style.display = 'none';
                dialogueSetting.style.display = 'block';
                characterSection.style.display = 'none';
                characterGroupsSection.style.display = 'none';
                defaultSetting.style.display = 'block';
                globalSpeedSetting.style.display = 'block';
                singleCharModeSetting.style.display = 'none';
            } else {
                narrationSetting.style.display = 'none';
                dialogueSetting.style.display = 'none';
                characterSection.style.display = 'none';
                characterGroupsSection.style.display = 'none';
                defaultSetting.style.display = 'block';
                globalSpeedSetting.style.display = 'block';
                singleCharModeSetting.style.display = 'none';
            }
        }
    }
    
    // 填充语音选择器
    function populateVoiceSelects() {
        const selects = ['default-voice-select', 'narration-voice-select', 'dialogue-voice-select'];

        selects.forEach(selectId => {
            const select = document.getElementById(selectId);
            if (select) {
                const defaultOptions = select.querySelectorAll('option[value=""], option[value="' + DO_NOT_PLAY_VALUE + '"]');
                select.innerHTML = '';
                defaultOptions.forEach(option => select.appendChild(option));

                ttsModels.forEach(model => {
                    const option = document.createElement('option');
                    option.value = model;
                    option.textContent = model;
                    select.appendChild(option);
                });

                if (selectId === 'default-voice-select') select.value = defaultVoice;
                else if (selectId === 'narration-voice-select') select.value = narrationVoice;
                else if (selectId === 'dialogue-voice-select') select.value = dialogueVoice;
            }
        });
    }

    // 更新感情选择器
    function updateEmotionSelect(modelName) {
        const modelData = ttsModelsWithDetails[modelName];
        const emotions = (modelData && Object.keys(modelData).length > 0) ? modelData[Object.keys(modelData)[0]] : ['默认'];
        populateEmotionSelect(emotions);
    }

    // 填充感情选择器
    function populateEmotionSelect(emotions) {
        const select = document.getElementById('emotion-select');
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
            Settings.save();
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

        const assignedCharacters = new Set();
        Object.values(characterGroups).forEach(group => {
            if (group.characters) {
                group.characters.forEach(char => assignedCharacters.add(char));
            }
        });

        const unassignedCharacters = Array.from(allDetectedCharacters).filter(char =>
            !assignedCharacters.has(char)
        );

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
                        <option value="${DO_NOT_PLAY_VALUE}">🔇 不播放</option>
                        ${modelsForVersion.map(model =>
                            `<option value="${model}" ${voice === model ? 'selected' : ''}>${model}</option>`
                        ).join('')}
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

        container.querySelectorAll('.tts-character-version').forEach(select => {
            select.addEventListener('change', async (e) => {
                const char = e.target.dataset.char;
                const newVersion = e.target.value;
                const voiceSelect = e.target.closest('.tts-character-controls').querySelector('.tts-character-voice');
                const currentVoice = voiceSelect.value;

                const models = await getModelsForVersion(newVersion);
                voiceSelect.innerHTML = `
                    <option value="">» 使用默认 «</option>
                    <option value="${DO_NOT_PLAY_VALUE}">🔇 不播放</option>
                    ${models.map(model => `<option value="${model}">${model}</option>`).join('')}
                `;

                if (models.includes(currentVoice)) {
                    voiceSelect.value = currentVoice;
                } else {
                    voiceSelect.value = '';
                }
                voiceSelect.dispatchEvent(new Event('change'));
            });
        });

        container.querySelectorAll('.tts-character-voice').forEach(select => {
            select.addEventListener('change', (e) => {
                const char = e.target.dataset.char;
                const voice = e.target.value;
                const version = e.target.closest('.tts-character-controls').querySelector('.tts-character-version').value;

                if (voice) {
                    characterVoices[char] = { voice, version, speed: characterVoices[char]?.speed || 1.0 };
                } else {
                    delete characterVoices[char];
                }
                Settings.save();
                updateEmotionSelect(voice || defaultVoice);
            });
        });

        container.querySelectorAll('.tts-character-speed-slider').forEach(slider => {
            const char = slider.dataset.char;
            const speedValue = container.querySelector(`.tts-character-speed-value[data-char="${char}"]`);

            slider.addEventListener('input', (e) => {
                speedValue.textContent = e.target.value;
            });

            slider.addEventListener('change', (e) => {
                const speed = parseFloat(e.target.value);
                if (characterVoices[char]) {
                    characterVoices[char].speed = speed;
                } else {
                    characterVoices[char] = { voice: '', version: ttsApiVersion, speed: speed };
                }
                Settings.save();
            });
        });

        container.querySelectorAll('.tts-delete-char').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const char = e.target.dataset.char;
                allDetectedCharacters.delete(char);
                delete characterVoices[char];
                Object.keys(characterGroups).forEach(groupName => {
                    const group = characterGroups[groupName];
                    if (group.characters) {
                        group.characters = group.characters.filter(c => c !== char);
                        if (group.characters.length === 0) {
                            delete characterGroups[groupName];
                        }
                    }
                });
                Settings.save();
                renderCharacterVoices();
                renderCharacterGroups();
            });
        });
    }

    // 显示单角色选择面板
    function showSingleCharacterSelector(button) {
        const existingPanel = document.getElementById('tts-single-char-panel');
        if (existingPanel) {
            existingPanel.remove();
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'tts-single-char-panel';
        panel.style.cssText = `
            position: fixed;
            background: white;
            border: 2px solid #667eea;
            border-radius: 12px;
            padding: 15px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            z-index: 10001;
            max-height: 400px;
            overflow-y: auto;
            min-width: 200px;
        `;

        const rect = button.getBoundingClientRect();
        panel.style.left = rect.left + 'px';
        panel.style.top = (rect.bottom + 5) + 'px';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 600; color: #667eea; margin-bottom: 10px; font-size: 14px;';
        title.textContent = '选择角色';
        panel.appendChild(title);

        const allOption = document.createElement('div');
        allOption.className = 'single-char-option';
        allOption.style.cssText = `
            padding: 8px 12px;
            margin: 4px 0;
            border-radius: 6px;
            cursor: pointer;
            transition: all 0.2s ease;
            background: ${!singleCharacterTarget ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' : '#f8f9fa'};
            color: ${!singleCharacterTarget ? 'white' : '#495057'};
            font-size: 13px;
        `;
        allOption.textContent = '» 全部角色 «';
        allOption.addEventListener('click', () => {
            singleCharacterTarget = '';
            Settings.save();
            lastMessageParts = [];
            lastProcessedMessageId = null;
            reparseCurrentMessage();
            showNotification('已切换到全部角色', 'info');
            
            const btn = document.getElementById('tts-single-char-select-btn');
            if (btn) btn.innerHTML = `<i class="icon">👤</i><span class="text">全部角色</span>`;
            panel.remove();
        });
        panel.appendChild(allOption);

        const divider = document.createElement('div');
        divider.style.cssText = 'height: 1px; background: #dee2e6; margin: 8px 0;';
        panel.appendChild(divider);

        const characters = Array.from(allDetectedCharacters).sort();
        if (characters.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.style.cssText = 'padding: 20px; text-align: center; color: #6c757d; font-size: 12px;';
            emptyMsg.textContent = '暂无检测到的角色';
            panel.appendChild(emptyMsg);
        } else {
            characters.forEach(char => {
                const charOption = document.createElement('div');
                charOption.className = 'single-char-option';
                charOption.style.cssText = `
                    padding: 8px 12px;
                    margin: 4px 0;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    background: ${singleCharacterTarget === char ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' : '#f8f9fa'};
                    color: ${singleCharacterTarget === char ? 'white' : '#495057'};
                    font-size: 13px;
                `;
                charOption.textContent = char;
                charOption.addEventListener('click', () => {
                    singleCharacterTarget = char;
                    Settings.save();
                    lastMessageParts = [];
                    lastProcessedMessageId = null;
                    reparseCurrentMessage();
                    showNotification(`已选择角色：${char}`, 'success');
                    
                    const btn = document.getElementById('tts-single-char-select-btn');
                    if (btn) btn.innerHTML = `<i class="icon">👤</i><span class="text">${char}</span>`;
                    panel.remove();
                });
                panel.appendChild(charOption);
            });
        }

        document.body.appendChild(panel);

        setTimeout(() => {
            document.addEventListener('click', function closePanel(e) {
                if (!panel.contains(e.target) && e.target !== button) {
                    panel.remove();
                    document.removeEventListener('click', closePanel);
                }
            });
        }, 100);
    }

    function updateSingleCharacterSelector() {
        const container = document.getElementById('tts-single-char-container');
        const btn = document.getElementById('tts-single-char-select-btn');
        if (!container || !btn) return;
        
        const shouldShow = isSingleCharacterMode && 
                          (detectionMode === 'character_and_dialogue' || detectionMode === 'character_emotion_and_dialogue');
        container.style.display = shouldShow ? 'block' : 'none';
        btn.innerHTML = `<i class="icon">👤</i><span class="text">${singleCharacterTarget || '全部角色'}</span>`;
    }

    // 渲染角色分组管理
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
            Object.values(characterGroups).forEach(g => {
                if (g.characters) {
                    g.characters.forEach(char => assignedCharacters.add(char));
                }
            });

            const unassignedCharacters = Array.from(allDetectedCharacters).filter(char =>
                !assignedCharacters.has(char) || (group.characters && group.characters.includes(char))
            );

            groupDiv.innerHTML = `
                <div class="tts-group-header" style="border-left: 4px solid ${group.color}" data-group="${groupName}">
                    <div class="tts-group-info">
                        <span class="tts-group-name">
                            <span class="tts-collapse-icon">▼</span>
                            ${groupName}
                        </span>
                        <span class="tts-group-count">${group.characters ? group.characters.length : 0} 个角色</span>
                    </div>
                    <button class="tts-delete-group" data-group="${groupName}">删除分组</button>
                </div>
                <div class="tts-group-content" style="display: none;">
                    <div class="tts-group-characters">
                        ${group.characters && group.characters.length > 0 ?
                           (await Promise.all(group.characters.map(async char => {
                                const voiceSetting = characterVoices[char];
                                const voice = typeof voiceSetting === 'object' ? voiceSetting.voice || '' : voiceSetting || '';
                                const version = typeof voiceSetting === 'object' ? voiceSetting.version || ttsApiVersion : ttsApiVersion;
                                const speed = typeof voiceSetting === 'object' ? voiceSetting.speed || 1.0 : 1.0;
                                const modelsForVersion = await getModelsForVersion(version);

                                return `
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
                                                    ${modelsForVersion.map(model =>
                                                        `<option value="${model}" ${voice === model ? 'selected' : ''}>${model}</option>`
                                                    ).join('')}
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
                            }))).join('') :
                            '<p class="tts-empty-state">暂无角色</p>'
                        }
                    </div>
                    ${unassignedCharacters.length > 0 ? `
                        <div class="tts-add-character">
                            <select class="tts-character-select" data-group="${groupName}">
                                <option value="">选择要添加的角色</option>
                                ${unassignedCharacters.map(char =>
                                    `<option value="${char}">${char}</option>`
                                ).join('')}
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

    // 绑定分组管理事件
    function bindGroupManagementEvents() {
        const container = document.getElementById('character-groups-container');
        if (!container) return;

        container.querySelectorAll('.tts-group-header').forEach(header => {
            header.addEventListener('click', (e) => {
                if (e.target.closest('.tts-delete-group')) return;
                const content = header.nextElementSibling;
                const icon = header.querySelector('.tts-collapse-icon');
                if (content.style.display === 'none') {
                    content.style.display = 'block';
                    icon.textContent = '▼';
                } else {
                    content.style.display = 'none';
                    icon.textContent = '▶';
                }
            });
        });

        container.querySelectorAll('.tts-character-version-in-group').forEach(select => {
            select.addEventListener('change', async (e) => {
                const newVersion = e.target.value;
                const voiceSelect = e.target.closest('.tts-character-controls-group').querySelector('.tts-character-voice-in-group');
                const currentVoice = voiceSelect.value;
                const models = await getModelsForVersion(newVersion);
                voiceSelect.innerHTML = `
                    <option value="">» 使用默认 «</option>
                    <option value="${DO_NOT_PLAY_VALUE}">🔇 不播放</option>
                    ${models.map(model => `<option value="${model}">${model}</option>`).join('')}
                `;
                if (models.includes(currentVoice)) voiceSelect.value = currentVoice;
                else voiceSelect.value = '';
                voiceSelect.dispatchEvent(new Event('change'));
            });
        });

        container.querySelectorAll('.tts-character-voice-in-group').forEach(select => {
            select.addEventListener('change', (e) => {
                const char = e.target.dataset.char;
                const voice = e.target.value;
                const version = e.target.closest('.tts-character-controls-group').querySelector('.tts-character-version-in-group').value;
                if (voice) {
                    characterVoices[char] = { voice, version, speed: characterVoices[char]?.speed || 1.0 };
                } else {
                    delete characterVoices[char];
                }
                Settings.save();
                updateEmotionSelect(voice || defaultVoice);
            });
        });

        container.querySelectorAll('.tts-character-speed-slider-in-group').forEach(slider => {
            const char = slider.dataset.char;
            const speedValue = container.querySelector(`.tts-character-speed-value-in-group[data-char="${char}"]`);
            slider.addEventListener('input', (e) => speedValue.textContent = e.target.value);
            slider.addEventListener('change', (e) => {
                const speed = parseFloat(e.target.value);
                if (characterVoices[char]) characterVoices[char].speed = speed;
                else characterVoices[char] = { voice: '', version: ttsApiVersion, speed: speed };
                Settings.save();
            });
        });

        container.querySelectorAll('.tts-delete-group').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const groupName = e.target.dataset.group;
                if (confirm(`确定要删除分组 "${groupName}" 吗？`)) {
                    delete characterGroups[groupName];
                    Settings.save();
                    renderCharacterGroups();
                    showNotification(`分组 "${groupName}" 已删除`, 'success');
                }
            });
        });

        container.querySelectorAll('.tts-remove-from-group').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const groupName = e.target.dataset.group;
                const charName = e.target.dataset.char;
                const group = characterGroups[groupName];
                if (group && group.characters) {
                    group.characters = group.characters.filter(c => c !== charName);
                    Settings.save();
                    renderCharacterGroups();
                    renderCharacterVoices();
                    showNotification(`已将 "${charName}" 从分组 "${groupName}" 中移除`, 'success');
                }
            });
        });

        container.querySelectorAll('.tts-add-to-group').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const groupName = e.target.dataset.group;
                const select = container.querySelector(`.tts-character-select[data-group="${groupName}"]`);
                const charName = select.value;
                if (!charName) return showNotification('请选择要添加的角色', 'warning');

                const group = characterGroups[groupName];
                if (group) {
                    if (!group.characters) group.characters = [];
                    Object.keys(characterGroups).forEach(otherGroupName => {
                        if (otherGroupName !== groupName) {
                            const otherGroup = characterGroups[otherGroupName];
                            if (otherGroup.characters) {
                                otherGroup.characters = otherGroup.characters.filter(c => c !== charName);
                            }
                        }
                    });
                    if (!group.characters.includes(charName)) group.characters.push(charName);
                    Settings.save();
                    renderCharacterGroups();
                    showNotification(`已将 "${charName}" 添加到分组 "${groupName}"`, 'success');
                }
            });
        });
    }

    function updateStatusIndicator() {
        const settingsIndicator = document.getElementById('settings-status-indicator');
        if (settingsIndicator) {
            const dot = settingsIndicator.querySelector('.status-dot');
            const text = settingsIndicator.querySelector('.status-text');
            if (autoPlayEnabled) {
                dot.classList.add('active');
                text.textContent = '自动播放模式';
            } else {
                dot.classList.remove('active');
                text.textContent = '手动播放模式';
            }
        }
    }

    function updateEdgeMode() {
        const panel = document.getElementById('tts-floating-panel');
        if (panel) {
            if (edgeMode) {
                panel.classList.add('edge-mode');
                panel.addEventListener('mouseenter', () => panel.classList.add('expanded'));
                panel.addEventListener('mouseleave', () => panel.classList.remove('expanded'));
            } else {
                panel.classList.remove('edge-mode', 'expanded');
                // 移除监听器可能需要保存引用，这里简化处理
                const newPanel = panel.cloneNode(true);
                panel.parentNode.replaceChild(newPanel, panel);
                // 重新绑定事件比较麻烦，暂时不移除监听器，而是通过 CSS 类控制行为
            }
        }
    }

    async function getModelsForVersion(version) {
        if (modelCache.has(version)) return modelCache.get(version);
        try {
            const response = await makeRequest(TTS_API_ENDPOINT_MODELS, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ version: version }),
                timeout: 10000
            });
            if (response.ok) {
                const data = await response.json();
                const models = Object.keys(data.models || {});
                modelCache.set(version, models);
                return models;
            }
            return [];
        } catch (error) {
            return [];
        }
    }

    // 使面板可拖拽
    function makeDraggable(element) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        const onMouseDown = (e) => {
            if (e.target.closest('.tts-control-btn')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = element.offsetLeft;
            startTop = element.offsetTop;
            element.style.cursor = 'move';
            element.classList.add('dragging');
            e.preventDefault();
        };

        const onTouchStart = (e) => {
            if (e.target.closest('.tts-control-btn')) return;
            isDragging = true;
            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            startLeft = element.offsetLeft;
            startTop = element.offsetTop;
            element.classList.add('dragging');
            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - element.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - element.offsetHeight));
            element.style.left = newLeft + 'px';
            element.style.top = newTop + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
        };

        const onTouchMove = (e) => {
            if (!isDragging) return;
            const touch = e.touches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - element.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - element.offsetHeight));
            element.style.left = newLeft + 'px';
            element.style.top = newTop + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
            e.preventDefault();
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                element.style.cursor = '';
                element.classList.remove('dragging');
            }
        };

        element.addEventListener('mousedown', onMouseDown);
        element.addEventListener('touchstart', onTouchStart);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('touchmove', onTouchMove);
        document.addEventListener('mouseup', onMouseUp);
        document.addEventListener('touchend', onMouseUp);
    }

    // 边缘隐藏功能
    let isEdgeHidden = false;
    let originalPosition = null;
    let edgeIndicatorLastTop = null;

    function toggleEdgeHide() {
        if (isEdgeHidden) showPanel();
        else hideToEdge();
    }

    function hideToEdge() {
        const panel = document.getElementById('tts-floating-panel');
        if (!panel) return;

        originalPosition = {
            left: panel.style.left,
            top: panel.style.top,
            right: panel.style.right,
            bottom: panel.style.bottom,
            transform: panel.style.transform
        };

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

        const onMouseDown = (e) => {
            e.stopPropagation();
            isDragging = true;
            hasDragged = false;
            startY = e.clientY;
            startTop = indicator.getBoundingClientRect().top;
            indicator.style.transition = 'none';
            indicator.style.transform = 'none';
            indicator.style.top = `${startTop}px`;
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };

        const onMouseMove = (e) => {
            if (!isDragging) return;
            if (!hasDragged && Math.abs(e.clientY - startY) > 5) hasDragged = true;
            if (!hasDragged) return;
            e.preventDefault();
            let newTop = startTop + (e.clientY - startY);
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - indicator.offsetHeight));
            indicator.style.top = `${newTop}px`;
        };

        const onMouseUp = () => {
            if (!isDragging) return;
            if (hasDragged) edgeIndicatorLastTop = indicator.style.top;
            isDragging = false;
            indicator.style.transition = '';
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        indicator.addEventListener('mousedown', onMouseDown);
        indicator.addEventListener('click', (e) => {
            if (hasDragged) {
                e.preventDefault();
                e.stopPropagation();
            } else {
                showPanel();
            }
        });
    }

    // 网络诊断
    async function runDiagnostic() {
        const diagnosticResults = [];
        showNotification("开始网络诊断...", 'info');

        try {
            const response = await fetch(`${ttsApiBaseUrl}/`);
            diagnosticResults.push(`✅ 基础连接: ${response.status} ${response.statusText}`);
        } catch (error) {
            diagnosticResults.push(`❌ 基础连接失败: ${error.message}`);
        }

        try {
            const response = await fetch(TTS_API_ENDPOINT_MODELS, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ version: ttsApiVersion })
            });
            if (response.ok) {
                const data = await response.json();
                const modelCount = Object.keys(data.models || {}).length;
                diagnosticResults.push(`✅ 模型API: 成功获取 ${modelCount} 个模型`);
            } else {
                diagnosticResults.push(`❌ 模型API: ${response.status} ${response.statusText}`);
            }
        } catch (error) {
            diagnosticResults.push(`❌ 模型API失败: ${error.message}`);
        }

        diagnosticResults.push(`📱 用户代理: ${navigator.userAgent}`);
        diagnosticResults.push(`🌐 平台: ${navigator.platform}`);
        
        const resultText = diagnosticResults.join('\n');
        
        // 创建诊断结果弹窗
        const modal = document.createElement('div');
        modal.className = 'tts-modal';
        modal.style.zIndex = '10002'; // 确保在设置面板之上
        modal.innerHTML = `
            <div class="tts-modal-content" style="max-width: 600px;">
                <div class="tts-modal-header">
                    <h2><i class="icon">🔍</i> 网络诊断结果</h2>
                    <button class="tts-close-btn">×</button>
                </div>
                <div class="tts-modal-body">
                    <pre style="background: #f8f9fa; padding: 15px; border-radius: 8px; font-size: 12px; white-space: pre-wrap; max-height: 400px; overflow-y: auto;">${resultText}</pre>
                    <div style="margin-top: 15px; text-align: center;">
                        <button id="copy-diag-btn" style="padding: 8px 16px; background: #667eea; color: white; border: none; border-radius: 6px; cursor: pointer;">复制结果</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        
        modal.querySelector('#copy-diag-btn').addEventListener('click', function() {
            navigator.clipboard.writeText(resultText);
            this.textContent = '已复制';
            setTimeout(() => this.textContent = '复制结果', 2000);
        });
        
        modal.querySelector('.tts-close-btn').addEventListener('click', () => modal.remove());
    }

    function showConsoleLogger() {
        // 简化版日志查看器
        const modal = document.createElement('div');
        modal.className = 'tts-modal';
        modal.style.zIndex = '10002';
        modal.innerHTML = `
            <div class="tts-modal-content" style="max-width: 800px;">
                <div class="tts-modal-header">
                    <h2><i class="icon">📋</i> 日志</h2>
                    <button class="tts-close-btn">×</button>
                </div>
                <div class="tts-modal-body">
                    <div style="background: #1e1e1e; color: #d4d4d4; padding: 15px; height: 400px; overflow-y: auto; font-family: monospace; font-size: 12px;">
                        ${consoleLogs.map(log => `[${log.timestamp}] [${log.type}] ${log.message}`).join('<br>')}
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('.tts-close-btn').addEventListener('click', () => modal.remove());
    }

    // 前端适配相关函数
    async function forceDetectCurrentMessageAdapted() {
        const chatContainer = document.querySelector('#chat');
        if (!chatContainer) return { success: false, message: 'Chat container not found' };
        
        const messages = chatContainer.querySelectorAll('.mes[is_user="false"]');
        if (messages.length === 0) return { success: false, message: '没有找到AI消息' };

        const lastMessageElement = messages[messages.length - 1];
        const messageTextElement = lastMessageElement.querySelector('.mes_text');
        if (!messageTextElement) return { success: false, message: '消息元素不存在' };

        // 简化处理：直接提取文本
        const fullText = messageTextElement.innerText;
        if (!fullText) return { success: false, message: '消息文本为空' };

        return {
            success: true,
            totalParts: 1, // 简单返回，后续 reparse 会重新处理
            detectedText: fullText
        };
    }
    
    function extractTextFromElementAdapted(element) {
        if (!element) return '';
        const iframes = element.querySelectorAll('iframe');
        if (iframes.length > 0) {
            let iframeText = '';
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc && iframeDoc.body) {
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
                    if (iframe.hasAttribute('srcdoc')) {
                        const srcdoc = iframe.getAttribute('srcdoc');
                        if (srcdoc) {
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = srcdoc;
                            const extractedText = extractFromJuusStructure(tempDiv);
                            if (extractedText) iframeText += extractedText;
                            if (!iframeText) {
                                const narrativeElements = tempDiv.querySelectorAll('.narrative-text');
                                if (narrativeElements.length > 0) {
                                    narrativeElements.forEach(elem => {
                                        const text = elem.innerText || elem.textContent;
                                        if (text && text.trim()) iframeText += text.trim() + '\n';
                                    });
                                }
                                if (!iframeText) {
                                    const allText = tempDiv.innerText || tempDiv.textContent;
                                    if (allText && allText.trim()) iframeText += allText.trim() + '\n';
                                }
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
                let character = '', emotion = '';
                if (metaDiv) {
                    const charSpan = metaDiv.querySelector('.dialogue-char');
                    const emoSpan = metaDiv.querySelector('.dialogue-emo');
                    if (charSpan) character = charSpan.textContent.replace(/【|】/g, '').trim();
                    if (emoSpan) emotion = emoSpan.textContent.replace(/〈|〉/g, '').trim();
                }
                const dialogueDiv = wrapper.querySelector('.dialogue-text');
                if (dialogueDiv) {
                    const dialogueText = dialogueDiv.dataset.fullText || dialogueDiv.textContent || '';
                    if (dialogueText.trim()) {
                        const isQuotedDialogue = dialogueDiv.classList.contains('dialogue-quote');
                        if (character) {
                            if (emotion) fullText += `【${character}】〈${emotion}〉「${dialogueText.trim()}」\n`;
                            else fullText += `【${character}】「${dialogueText.trim()}」\n`;
                        } else if (isQuotedDialogue) {
                            fullText += `「${dialogueText.trim()}」\n`;
                        } else {
                            fullText += `${dialogueText.trim()}\n`;
                        }
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
        return fullText.trim();
    }

    async function waitForIframesLoadAdapted(element) {
        return new Promise((resolve) => {
            const iframes = element.querySelectorAll('iframe');
            if (iframes.length === 0) {
                resolve();
                return;
            }
            let loadedCount = 0;
            const checkAllLoaded = () => {
                loadedCount++;
                if (loadedCount >= iframes.length) resolve();
            };
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

    async function handleFrontendDetectClick() {
        if (isPlaying) return showNotification("正在播放中，请先停止。", 'info');
        try {
            showNotification("正在使用前端适配模式检测...", 'info');
            const originalLog = console.log;
            const detectionLogs = [];
            console.log = function(...args) {
                const message = args.join(' ');
                if (message.includes('提取到的完整文本长度:') || message.includes('开始处理文本') || message.includes('检测到')) {
                    detectionLogs.push(message);
                }
                originalLog.apply(console, args);
            };
            const result = await forceDetectCurrentMessageAdapted();
            console.log = originalLog;
            if (result.success) {
                showNotification(`前端适配检测成功！检测到 ${result.totalParts} 个语音片段。`, 'success');
                // 这里省略检测详情弹窗，直接更新按钮状态
                const playButton = document.getElementById('tts-play-btn');
                if (playButton) playButton.disabled = result.totalParts === 0;
            } else {
                showNotification(`前端适配检测失败：${result.message}`, 'error');
            }
        } catch (error) {
            showNotification(`前端适配检测出错：${error.message}`, 'error');
        }
    }
    
    // 覆盖之前简化的 forceDetectCurrentMessageAdapted
    async function forceDetectCurrentMessageAdapted() {
        const messages = document.querySelectorAll('div.mes[is_user="false"]');
        if (messages.length === 0) return { success: false, message: '没有找到AI消息' };
        const lastMessageElement = messages[messages.length - 1];
        const messageTextElement = lastMessageElement.querySelector('.mes_text');
        if (!messageTextElement) return { success: false, message: '消息元素不存在' };
        
        await waitForIframesLoadAdapted(messageTextElement);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const fullText = extractTextFromElementAdapted(messageTextElement);
        if (!fullText) return { success: false, message: '消息文本为空' };
        
        // 这里简单模拟 processMessageText 的返回结果，或者需要把 processMessageText 也搬过来
        // 为了完整性，我们把 processMessageText 也搬过来
        return processMessageText(fullText, lastMessageElement);
    }

    function processMessageText(fullText, messageElement) {
        const currentMessageParts = [];
        let hasNewCharacter = false;
        let newCharacterCount = 0;
        let actualDialogueCount = 0;
        const validDialogueRegex = /[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff]/;

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
                const emotion = match[2].trim();
                const dialogue = match[3].trim();
                if (dialogue && validDialogueRegex.test(dialogue)) {
                    currentMessageParts.push({ type: 'character_emotion_dialogue', character, emotion, dialogue });
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
                const emotion = match[1].trim();
                const dialogue = match[2].trim();
                if (dialogue && validDialogueRegex.test(dialogue)) {
                    currentMessageParts.push({ type: 'emotion_dialogue', emotion, dialogue });
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
            if (allDialogues.length > 0) {
                currentMessageParts.push({ type: 'dialogue_only', dialogue: allDialogues.join('\n') });
            }
        } else if (detectionMode === 'entire_message') {
            const trimmedText = fullText.trim();
            if (trimmedText) {
                currentMessageParts.push({ type: 'entire_message', dialogue: trimmedText });
                actualDialogueCount = 1;
            }
        }

        if (hasNewCharacter) Settings.save();
        lastMessageParts = currentMessageParts;
        const messageId = messageElement.getAttribute('mesid') || messageElement.textContent.substring(0, 50) || Date.now().toString();
        lastProcessedMessageId = messageId;

        return {
            success: true,
            totalParts: currentMessageParts.length,
            characterCount: newCharacterCount,
            detectedText: fullText.substring(0, 100) + (fullText.length > 100 ? '...' : ''),
            actualDialogueCount: actualDialogueCount,
            hasNewCharacter: hasNewCharacter
        };
    }
    
})();
