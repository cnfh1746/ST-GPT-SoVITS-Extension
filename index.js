(function() {
    'use strict';

    // ==================== API 适配配置 ====================
    // 在这里配置不同版本的 API 映射
    const API_ADAPTERS = {
        // GSVI 模式 (推荐): 适用于运行 gsvi.py 的整合包 (旧版及新版 gsvi.bat)
        // 支持自动情感切换、模型获取
        'gsvi': {
            infer_endpoint: '/infer_single',
            models_endpoint: '/models',
            method: 'POST',
            body_type: 'json',
            params_map: {
                text: 'text',
                text_lang: 'text_lang',
                model_name: 'model_name',
                prompt_text_lang: 'prompt_text_lang',
                version: 'version',
                emotion: 'emotion',
                speed_facter: 'speed_facter'
            }
        },
        // 官方 API 模式: 适用于运行 api.py 或 api_v2.py
        'new_1007': {
            infer_endpoint: '/tts', 
            models_endpoint: null, // 官方 API 无获取模型列表接口
            method: 'POST',
            body_type: 'json',
            params_map: {
                text: 'text',
                text_lang: 'text_lang',
                // 下面这些是 api_v2.py 的特定参数
                ref_audio_path: 'ref_audio_path',
                prompt_text: 'prompt_text',
                prompt_lang: 'prompt_lang',
                speed_factor: 'speed_factor',
                text_split_method: 'text_split_method'
            },
            extra_params: {
                media_type: "wav",
                streaming_mode: false
            }
        }
    };

    // ==================== 全局变量 ====================
    let ttsApiBaseUrl = "http://127.0.0.1:9880"; // gsvi.bat 默认端口为 9880
    let currentApiMode = 'gsvi'; // 默认为 gsvi 模式
    
    let TTS_API_ENDPOINT_INFER = "";
    let TTS_API_ENDPOINT_MODELS = "";
    
    // 官方 API 模式需要的参考音频配置
    let defaultRefAudioPath = "";
    let defaultPromptText = "";
    let defaultPromptLang = "";

    const DO_NOT_PLAY_VALUE = '_DO_NOT_PLAY_';
    const DEFAULT_DETECTION_MODE = 'character_and_dialogue';

    // 控制台日志存储
    let consoleLogs = [];
    const originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info
    };

    // 状态变量
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

    let isProcessingQueue = false;
    let currentPlaybackIndex = 0;
    let playbackSequenceId = 0;

    // 缓存
    let audioCache = new Map();
    let generationPromises = new Map();
    let maxConcurrentGenerations = 3;
    let currentGenerations = 0;
    let preloadEnabled = true;
    let batchMode = true;

    let autoPlayEnabled = false;
    let quotationStyle = 'japanese';
    let edgeMode = false;
    let frontendAdaptationEnabled = false;
    let isSingleCharacterMode = false;
    let singleCharacterTarget = '';

    let lastProcessedMessageId = null;
    let lastProcessedText = '';
    let autoPlayTimeout = null;

    // ==================== 存储管理 (替代 GM_setValue/getValue) ====================
    const STORAGE_PREFIX = 'st_gpt_sovits_';
    
    const Settings = {
        load: function() {
            const get = (key, def) => {
                const val = localStorage.getItem(STORAGE_PREFIX + key);
                try {
                    return val ? JSON.parse(val) : def;
                } catch (e) {
                    return def;
                }
            };

            ttsApiBaseUrl = get('ttsApiBaseUrl_v18_3', 'http://127.0.0.1:9880');
            currentApiMode = get('apiMode', 'gsvi');
            updateApiEndpoints();
            
            ttsApiVersion = get('ttsApiVersion_v18_3', 'v4');
            detectionMode = get('detectionMode_v18_3', DEFAULT_DETECTION_MODE);
            speedFacter = get('speedFacter_v18_3', 1.0);
            emotion = get('emotion_v18_3', '默认');
            narrationVoice = get('narrationVoice_v18_3', '');
            dialogueVoice = get('dialogueVoice_v18_3', '');
            characterVoices = get('characterVoices_v18_3', {});
            characterGroups = get('characterGroups_v18_3', {});
            defaultVoice = get('defaultVoice_v18_3', '');
            
            const savedChars = get('allDetectedCharacters_v18_3', []);
            allDetectedCharacters = new Set(savedChars);
            
            maxConcurrentGenerations = get('maxConcurrentGenerations_v18_3', 3);
            preloadEnabled = get('preloadEnabled_v18_3', true);
            batchMode = get('batchMode_v18_3', true);
            autoPlayEnabled = get('autoPlayEnabled_v18_3', false);
            quotationStyle = get('quotationStyle_v18_3', 'japanese');
            edgeMode = get('edgeMode_v18_3', false);
            frontendAdaptationEnabled = get('frontendAdaptationEnabled_v18_3', false);
            isSingleCharacterMode = get('isSingleCharacterMode_v18_3', false);
            singleCharacterTarget = get('singleCharacterTarget_v18_3', '');
            
            defaultRefAudioPath = get('defaultRefAudioPath', '');
            defaultPromptText = get('defaultPromptText', '');
            defaultPromptLang = get('defaultPromptLang', '');
        },
        save: function() {
            const set = (key, val) => localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(val));
            
            set('ttsApiBaseUrl_v18_3', ttsApiBaseUrl);
            set('apiMode', currentApiMode);
            set('ttsApiVersion_v18_3', ttsApiVersion);
            set('detectionMode_v18_3', detectionMode);
            set('speedFacter_v18_3', speedFacter);
            set('emotion_v18_3', emotion);
            set('narrationVoice_v18_3', narrationVoice);
            set('dialogueVoice_v18_3', dialogueVoice);
            set('characterVoices_v18_3', characterVoices);
            set('characterGroups_v18_3', characterGroups);
            set('defaultVoice_v18_3', defaultVoice);
            set('allDetectedCharacters_v18_3', Array.from(allDetectedCharacters));
            set('maxConcurrentGenerations_v18_3', maxConcurrentGenerations);
            set('preloadEnabled_v18_3', preloadEnabled);
            set('batchMode_v18_3', batchMode);
            set('autoPlayEnabled_v18_3', autoPlayEnabled);
            set('quotationStyle_v18_3', quotationStyle);
            set('edgeMode_v18_3', edgeMode);
            set('frontendAdaptationEnabled_v18_3', frontendAdaptationEnabled);
            set('isSingleCharacterMode_v18_3', isSingleCharacterMode);
            set('singleCharacterTarget_v18_3', singleCharacterTarget);
            
            set('defaultRefAudioPath', defaultRefAudioPath);
            set('defaultPromptText', defaultPromptText);
            set('defaultPromptLang', defaultPromptLang);
        }
    };

    function updateApiEndpoints() {
        const adapter = API_ADAPTERS[currentApiMode] || API_ADAPTERS['gsvi'];
        TTS_API_ENDPOINT_INFER = `${ttsApiBaseUrl}${adapter.infer_endpoint}`;
        TTS_API_ENDPOINT_MODELS = `${ttsApiBaseUrl}${adapter.models_endpoint}`;
    }

    // ==================== 核心逻辑 ====================

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
            emotion: currentEmotion, speedFacter: currentSpeed, ttsApiVersion: task.version || ttsApiVersion, apiMode: currentApiMode
        });

        if (!task.bypassCache) {
            if (audioCache.has(cacheKey)) {
                const cached = audioCache.get(cacheKey);
                if (cached.timestamp > Date.now() - 300000) {
                    return { ...cached, fromCache: true };
                } else {
                    if (cached.blobUrl) URL.revokeObjectURL(cached.blobUrl);
                    audioCache.delete(cacheKey);
                }
            }
            if (generationPromises.has(cacheKey)) return await generationPromises.get(cacheKey);
        }

        while (currentGenerations >= maxConcurrentGenerations) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        currentGenerations++;

        const generationPromise = new Promise((resolve, reject) => {
            const lang = detectLanguage(task.dialogue);
            const adapter = API_ADAPTERS[currentApiMode] || API_ADAPTERS['gsvi'];
            const map = adapter.params_map;

            // 构建参数
            let params = {};
            
            if (currentApiMode === 'gsvi') {
                params = {
                    [map.text]: task.dialogue,
                    [map.model_name]: task.voice,
                    [map.text_lang]: lang,
                    [map.prompt_text_lang]: lang,
                    [map.version]: task.version || ttsApiVersion,
                    [map.emotion]: currentEmotion,
                    [map.speed_facter]: currentSpeed,
                    batch_size: task.isBatch ? 20 : 10,
                    batch_threshold: 0.75,
                    fragment_interval: 0.3,
                    media_type: "wav",
                    parallel_infer: true,
                    repetition_penalty: 1.35,
                    seed: -1,
                    split_bucket: true,
                    temperature: 1,
                    top_k: 10,
                    top_p: 1
                };
            } else if (currentApiMode === 'new_1007') {
                // 转换语言代码 (api_v2.py 需要 "zh", "en", "ja")
                const langCode = lang === "日语" ? "ja" : (lang === "中文" ? "zh" : "en");
                const promptLangCode = defaultPromptLang === "日语" ? "ja" : (defaultPromptLang === "中文" ? "zh" : (defaultPromptLang === "英文" ? "en" : "zh"));

                params = {
                    [map.text]: task.dialogue,
                    [map.text_lang]: langCode,
                    [map.ref_audio_path]: defaultRefAudioPath,
                    [map.prompt_text]: defaultPromptText,
                    [map.prompt_lang]: promptLangCode,
                    [map.speed_factor]: currentSpeed,
                    text_split_method: "cut5",
                    top_k: 5,
                    top_p: 1,
                    temperature: 1
                };
            }

            if (adapter.extra_params) {
                Object.assign(params, adapter.extra_params);
            }

            // 发送请求
            makeRequest(TTS_API_ENDPOINT_INFER, {
                method: adapter.method,
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/plain, */*"
                },
                data: adapter.body_type === 'json' ? JSON.stringify(params) : new URLSearchParams(params).toString(),
                timeout: 30000
            }).then(response => {
                currentGenerations--;
                generationPromises.delete(cacheKey);

                if (response.status === 200) {
                    try {
                        const data = JSON.parse(response.responseText);
                        // 适配不同的响应格式：有些 API 返回 audio_url，有些直接返回 binary?
                        // 目前假设返回 JSON 包含 audio_url，如果是直接返回 blob，需要修改 makeRequest
                        if (data.audio_url || data.audio) { // 兼容 data.audio 可能包含 base64
                            const result = {
                                url: data.audio_url, // 如果是 base64 这里的逻辑需要改，暂定 API 返回 url
                                timestamp: Date.now(),
                                task: task
                            };
                            audioCache.set(cacheKey, result);
                            cleanupCache();
                            resolve(result);
                        } else {
                            console.error('TTS生成失败: 响应中无 audio_url', data);
                            reject(new Error(data.reason || "API未返回audio_url"));
                        }
                    } catch (e) {
                         // 尝试检查是否直接返回了音频流（blob）
                         // 这部分逻辑比较复杂，fetch 处理 blob 更容易
                         console.error('解析响应失败', e);
                         reject(new Error("无法解析服务器响应"));
                    }
                } else {
                    reject(new Error(`TTS API 错误: ${response.status}`));
                }
            }).catch(error => {
                currentGenerations--;
                generationPromises.delete(cacheKey);
                reject(error);
            });
        });

        generationPromises.set(cacheKey, generationPromise);
        return await generationPromise;
    }

    async function makeRequest(url, options = {}) {
        const response = await fetch(url, {
            method: options.method || "GET",
            headers: options.headers || {},
            body: options.data,
            mode: 'cors'
        });
        
        const text = await response.text();
        return {
            status: response.status,
            statusText: response.statusText,
            responseText: text
        };
    }
    
    async function fetchAudioBlob(url) {
        const response = await fetch(url);
        if (response.ok) {
            const blob = await response.blob();
            return URL.createObjectURL(blob);
        }
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    // ... (UI 创建和事件绑定代码需要大幅简化和适配) ...
    
    // 检测语言
    function detectLanguage(text) {
        const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
        return japaneseRegex.test(text) ? "日语" : "中文";
    }

    // ==================== UI 界面 ====================
    
    function createUI() {
        if (document.getElementById('tts-floating-panel')) return;
        
        const panel = document.createElement('div');
        panel.id = 'tts-floating-panel';
        panel.className = `tts-panel ${edgeMode ? 'edge-mode' : ''}`;
        
        const mainControls = document.createElement('div');
        mainControls.className = 'tts-main-controls';
        
        const playBtn = createBtn('tts-play-btn', 'primary', '▶', '播放', handlePlayPauseResumeClick);
        const stopBtn = createBtn('tts-stop-btn', 'danger', '⏹', '停止', handleStopClick);
        stopBtn.style.display = 'none';
        const settingsBtn = createBtn('tts-settings-btn', 'settings', '⚙', '设置', toggleSettingsPanel);
        
        mainControls.appendChild(playBtn);
        mainControls.appendChild(stopBtn);
        mainControls.appendChild(settingsBtn);
        
        panel.appendChild(mainControls);
        document.body.appendChild(panel);
        makeDraggable(panel);
    }
    
    function createBtn(id, type, icon, title, handler) {
        const btn = document.createElement('button');
        btn.id = id;
        btn.className = `tts-control-btn ${type}`;
        btn.innerHTML = `<i class="icon">${icon}</i>`;
        btn.title = title;
        btn.onclick = handler;
        return btn;
    }

    // ... (设置面板、拖拽逻辑等，尽量保留旧版逻辑但简化) ...

    function toggleSettingsPanel() {
        const existing = document.getElementById('tts-settings-modal');
        if (existing) { existing.remove(); return; }
        createSettingsPanel();
    }

    function createSettingsPanel() {
        const modal = document.createElement('div');
        modal.id = 'tts-settings-modal';
        modal.className = 'tts-modal';
        
        // 构建设置内容 HTML
        // ...
        modal.innerHTML = `
            <div class="tts-modal-content">
                <div class="tts-modal-header">
                    <h2>TTS 设置</h2>
                    <button class="tts-close-btn" onclick="this.closest('.tts-modal').remove()">×</button>
                </div>
                <div class="tts-modal-body">
                    <div class="tts-setting-section">
                        <h3>基础设置</h3>
                        <div class="tts-setting-item">
                            <label>API 地址</label>
                            <input type="text" id="api-base-url" value="${ttsApiBaseUrl}">
                        </div>
                        <div class="tts-setting-item">
                            <label>API 适配模式</label>
                            <select id="api-mode-select">
                                <option value="gsvi" ${currentApiMode === 'gsvi' ? 'selected' : ''}>GSVI (支持情感 - 推荐)</option>
                                <option value="new_1007" ${currentApiMode === 'new_1007' ? 'selected' : ''}>Official API (无情感)</option>
                            </select>
                            <p class="tts-setting-desc">GSVI模式需运行 gsvi.bat (默认端口9880)</p>
                        </div>
                        <div class="tts-setting-item" id="legacy-voice-setting" style="display: ${currentApiMode === 'gsvi' ? 'block' : 'none'}">
                             <label>默认语音 (GSVI模式)</label>
                             <select id="default-voice-select"><option value="">加载中...</option></select>
                        </div>
                        
                        <div class="tts-setting-item" id="new-api-setting" style="display: ${currentApiMode === 'new_1007' ? 'block' : 'none'}; background: #f0f0f0; padding: 10px; border-radius: 5px;">
                            <label style="font-weight:bold;">参考音频设置 (Official模式必填)</label>
                            <p class="tts-setting-desc">请填写新版整合包中参考音频的绝对路径</p>
                            <div style="margin-top:5px;">
                                <label>参考音频路径 (ref_audio_path)</label>
                                <input type="text" id="ref-audio-path" value="${defaultRefAudioPath}" placeholder="例如: D:\\TTS\\ref.wav">
                            </div>
                            <div style="margin-top:5px;">
                                <label>参考音频文本 (prompt_text)</label>
                                <input type="text" id="prompt-text" value="${defaultPromptText}" placeholder="参考音频对应的文本内容">
                            </div>
                            <div style="margin-top:5px;">
                                <label>参考音频语言 (prompt_lang)</label>
                                <select id="prompt-lang">
                                    <option value="中文" ${defaultPromptLang === '中文' ? 'selected' : ''}>中文 (zh)</option>
                                    <option value="日语" ${defaultPromptLang === '日语' ? 'selected' : ''}>日语 (ja)</option>
                                    <option value="英文" ${defaultPromptLang === '英文' ? 'selected' : ''}>英文 (en)</option>
                                </select>
                            </div>
                        </div>

                        <div class="tts-setting-item">
                            <label>语速: <span id="speed-value">${speedFacter}</span></label>
                            <input type="range" id="speed-slider" min="0.5" max="2.0" step="0.01" value="${speedFacter}">
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        // 绑定事件
        document.getElementById('api-base-url').onchange = (e) => {
            ttsApiBaseUrl = e.target.value;
            updateApiEndpoints();
            Settings.save();
        };
        
        document.getElementById('api-mode-select').onchange = (e) => {
            currentApiMode = e.target.value;
            updateApiEndpoints();
            Settings.save();
            
            // 切换 UI 显示
            const isGsvi = currentApiMode === 'gsvi';
            document.getElementById('legacy-voice-setting').style.display = isGsvi ? 'block' : 'none';
            document.getElementById('new-api-setting').style.display = isGsvi ? 'none' : 'block';
            
            if (isGsvi) fetchTTSModels(); 
        };
        
        // 新版参数绑定
        document.getElementById('ref-audio-path').onchange = (e) => {
            defaultRefAudioPath = e.target.value;
            Settings.save();
        };
        document.getElementById('prompt-text').onchange = (e) => {
            defaultPromptText = e.target.value;
            Settings.save();
        };
        document.getElementById('prompt-lang').onchange = (e) => {
            defaultPromptLang = e.target.value;
            Settings.save();
        };

        document.getElementById('speed-slider').oninput = (e) => {
            document.getElementById('speed-value').textContent = e.target.value;
        };
        document.getElementById('speed-slider').onchange = (e) => {
            speedFacter = parseFloat(e.target.value);
            Settings.save();
        };
        
        document.getElementById('default-voice-select').onchange = (e) => {
            defaultVoice = e.target.value;
            Settings.save();
        };

        if (currentApiMode === 'gsvi') populateVoiceSelects();
    }

    async function fetchTTSModels() {
        // New 模式下没有模型列表接口，直接跳过
        if (currentApiMode === 'new_1007') return;

        const select = document.getElementById('default-voice-select');
        if (select) select.innerHTML = '<option>加载中...</option>';
        
        try {
            const adapter = API_ADAPTERS[currentApiMode] || API_ADAPTERS['gsvi'];
            
            // GSVI 模式使用 POST /models
            const response = await makeRequest(TTS_API_ENDPOINT_MODELS, {
                method: "POST", 
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ version: ttsApiVersion })
            });
            
            if (response.status === 200) {
                const data = JSON.parse(response.responseText);
                let models = [];
                if (data.models) {
                    models = Array.isArray(data.models) ? data.models : Object.keys(data.models);
                    ttsModelsWithDetails = Array.isArray(data.models) ? {} : data.models;
                } else if (Array.isArray(data)) {
                    models = data;
                }
                
                ttsModels = models;
                populateVoiceSelects();
            }
        } catch (e) {
            console.error("获取模型失败", e);
            if (select) select.innerHTML = '<option value="">获取失败 (请检查API地址或模式)</option>';
        }
    }

    function populateVoiceSelects() {
        const select = document.getElementById('default-voice-select');
        if (!select) return;
        select.innerHTML = '<option value="">» 选择语音模型 «</option>';
        ttsModels.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            if (m === defaultVoice) opt.selected = true;
            select.appendChild(opt);
        });
    }

    // ==================== 播放控制与消息监听 ====================
    
    function handlePlayPauseResumeClick() {
        if (isPlaying) {
             handleStopClick(); // 简单起见，暂停即停止
             return;
        }
        
        // 获取最后一条消息并播放
        const messages = document.querySelectorAll('.mes_text');
        if (messages.length === 0) return;
        
        const lastMsg = messages[messages.length - 1];
        const text = lastMsg.innerText;
        
        // 简单的解析逻辑 (支持 *角色* <u>情感</u>「内容」)
        // 这里简化了旧脚本复杂的解析，仅做示例
        const tasks = parseMessage(text);
        
        if (tasks.length > 0) {
            isPlaying = true;
            document.getElementById('tts-play-btn').innerHTML = '<i class="icon">⏹</i>';
            processTasks(tasks);
        }
    }
    
    function handleStopClick() {
        isPlaying = false;
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }
        document.getElementById('tts-play-btn').innerHTML = '<i class="icon">▶</i>';
        document.getElementById('tts-stop-btn').style.display = 'none';
    }
    
    function parseMessage(text) {
        // 适配 AI输出格式指令匹配tts.txt 中的格式
        // *角色名* <u>情感</u>「对话内容」
        const regex = /\*([^*]+)\*\s*<u>([^<]+)<\/u>\s*[「]([^」]+)[」]/g;
        const tasks = [];
        let match;
        
        while ((match = regex.exec(text)) !== null) {
            tasks.push({
                character: match[1],
                emotion: match[2],
                dialogue: match[3],
                voice: characterVoices[match[1]] || defaultVoice // 需要角色管理支持
            });
        }
        
        // 如果没有匹配到特定格式，则整段朗读
        if (tasks.length === 0) {
            tasks.push({
                character: 'default',
                emotion: emotion,
                dialogue: text,
                voice: defaultVoice
            });
        }
        
        return tasks;
    }
    
    async function processTasks(tasks) {
        for (const task of tasks) {
            if (!isPlaying) break;
            if (!task.voice) continue;
            
            try {
                const result = await generateSingleAudio(task);
                if (result && result.url) {
                    const blobUrl = await fetchAudioBlob(result.url);
                    await playAudio(blobUrl);
                }
            } catch (e) {
                console.error(e);
            }
        }
        handleStopClick();
    }
    
    function playAudio(url) {
        return new Promise((resolve, reject) => {
            const audio = new Audio(url);
            currentAudio = audio;
            audio.onended = resolve;
            audio.onerror = reject;
            audio.play();
        });
    }

    // 拖拽功能
    function makeDraggable(element) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        element.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = element.offsetLeft;
            startTop = element.offsetTop;
            element.style.cursor = 'move';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const newLeft = startLeft + (e.clientX - startX);
            const newTop = startTop + (e.clientY - startY);
            element.style.left = `${newLeft}px`;
            element.style.top = `${newTop}px`;
            element.style.transform = 'none'; // 移除居中变换
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            element.style.cursor = 'default';
        });
    }

    // 初始化
    Settings.load();
    createUI();
    fetchTTSModels();

})();
