/**
 * GPT-SoVITS TTS Player for SillyTavern
 * 完整移植自油猴脚本 v18.7
 */

import { extension_settings, saveSettingsDebounced } from '../../../extensions.js';

(function () {
    'use strict';

    const EXTENSION_NAME = "ST-GPT-SoVITS-Extension";
    const SETTINGS_KEY = "gpt_sovits_player";

    // 确保 extension_settings 中有我们的 key
    if (!extension_settings[SETTINGS_KEY]) {
        extension_settings[SETTINGS_KEY] = {};
    }

    // API地址配置变量
    let ttsApiBaseUrl = "http://127.0.0.1:8000";
    let TTS_API_ENDPOINT_INFER = "";
    let TTS_API_ENDPOINT_MODELS = "";

    const DO_NOT_PLAY_VALUE = '_DO_NOT_PLAY_';
    const DEFAULT_DETECTION_MODE = 'character_and_dialogue';

    // 控制台日志存储
    let consoleLogs = [];

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
    let ttsModels = [], ttsModelsWithDetails = {}, characterVoices = {}, defaultVoice = '',
        allDetectedCharacters = new Set(),
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
    let edgeMode = false;

    // 前端美化适配相关变量
    let frontendAdaptationEnabled = false;

    // 单角色模式相关变量
    let isSingleCharacterMode = false;
    let singleCharacterTarget = '';

    // 修复重复播放问题的变量
    let lastProcessedMessageId = null;
    let lastProcessedText = '';
    let autoPlayTimeout = null;

    // 边缘隐藏相关变量
    let isEdgeHidden = false;
    let originalPosition = null;

    const Settings = {
        load: function () {
            const s = extension_settings[SETTINGS_KEY] || {};

            ttsApiBaseUrl = s.ttsApiBaseUrl || 'http://127.0.0.1:8000';
            updateApiEndpoints();

            ttsApiVersion = s.ttsApiVersion || 'v4';
            detectionMode = s.detectionMode || DEFAULT_DETECTION_MODE;
            speedFacter = s.speedFacter ?? 1.0;
            emotion = s.emotion || '默认';
            narrationVoice = s.narrationVoice || '';
            dialogueVoice = s.dialogueVoice || '';
            characterVoices = s.characterVoices || {};
            characterGroups = s.characterGroups || {};
            defaultVoice = s.defaultVoice || '';

            const savedChars = s.allDetectedCharacters || [];
            allDetectedCharacters = new Set(savedChars);

            maxConcurrentGenerations = s.maxConcurrentGenerations || 3;
            preloadEnabled = s.preloadEnabled !== undefined ? s.preloadEnabled : true;
            batchMode = s.batchMode !== undefined ? s.batchMode : true;
            autoPlayEnabled = s.autoPlayEnabled || false;
            quotationStyle = s.quotationStyle || 'japanese';
            edgeMode = s.edgeMode || false;
            frontendAdaptationEnabled = s.frontendAdaptationEnabled || false;
            isSingleCharacterMode = s.isSingleCharacterMode || false;
            singleCharacterTarget = s.singleCharacterTarget || '';
        },
        save: function () {
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

    // 网络请求封装 (使用 fetch)
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

            // 模拟GM响应格式
            const text = await response.text();
            return {
                status: response.status,
                statusText: response.statusText,
                responseText: text,
                ok: response.ok
            };
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    // 获取音频Blob
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

    // 检测语言
    function detectLanguage(text) {
        const japaneseRegex = /[\u3040-\u309F\u30A0-\u30FF]/;
        return japaneseRegex.test(text) ? "日语" : "中文";
    }

    // 获取对话正则
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

    // 获取TTS模型列表
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

    // 获取指定版本的模型列表
    async function getModelsForVersion(version) {
        if (modelCache.has(version)) {
            return modelCache.get(version);
        }

        try {
            const response = await makeRequest(TTS_API_ENDPOINT_MODELS, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ version: version }),
                timeout: 10000
            });

            if (response.status === 200) {
                const data = JSON.parse(response.responseText);
                const models = Object.keys(data.models || {});
                modelCache.set(version, models);
                return models;
            }
        } catch (error) {
            console.error(`获取版本 ${version} 模型失败:`, error);
        }
        return ttsModels;
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

    // 创建通知容器
    function createNotificationContainer() {
        const container = document.createElement('div');
        container.id = 'tts-notification-container';
        document.body.appendChild(container);
        return container;
    }

    // 显示通知
    function showNotification(message, type = 'info', duration = 3000) {
        // 优先使用toastr
        if (window.toastr) {
            const fn = type === 'error' ? 'error' : (type === 'warning' ? 'warning' : (type === 'success' ? 'success' : 'info'));
            window.toastr[fn](message);
            return;
        }

        const container = document.getElementById('tts-notification-container') || createNotificationContainer();
        const notification = document.createElement('div');
        notification.className = `tts-notification ${type}`;
        notification.textContent = message;

        container.appendChild(notification);

        setTimeout(() => {
            notification.classList.add('show');
        }, 100);

        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => {
                if (notification.parentNode) {
                    notification.parentNode.removeChild(notification);
                }
            }, 300);
        }, duration);
    }

    // 填充语音选择下拉框
    function populateVoiceSelects() {
        const selects = document.querySelectorAll('.tts-voice-select');
        selects.forEach(select => {
            const currentValue = select.value;
            select.innerHTML = `<option value="">-- 选择语音 --</option>
                <option value="${DO_NOT_PLAY_VALUE}">不播放</option>`;
            ttsModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                select.appendChild(option);
            });
            if (currentValue) select.value = currentValue;
        });
    }

    // 更新情绪选择
    function updateEmotionSelect(voiceName) {
        const emotionSelect = document.getElementById('tts-emotion-select');
        if (!emotionSelect) return;

        emotionSelect.innerHTML = '<option value="默认">默认</option>';

        if (voiceName && ttsModelsWithDetails[voiceName]) {
            const modelData = ttsModelsWithDetails[voiceName];
            const allEmotions = new Set();
            Object.values(modelData).forEach(emotions => {
                if (Array.isArray(emotions)) {
                    emotions.forEach(e => allEmotions.add(e));
                }
            });
            allEmotions.forEach(e => {
                if (e !== '默认') {
                    const option = document.createElement('option');
                    option.value = e;
                    option.textContent = e;
                    emotionSelect.appendChild(option);
                }
            });
        }
        emotionSelect.value = emotion;
    }

    // 更新播放按钮
    function updatePlayButton(icon, text) {
        const playButton = document.getElementById('tts-play-btn');
        if (playButton) {
            playButton.innerHTML = `<i class="icon">${icon}</i><span class="text">${text}</span>`;
        }
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
                showNotification('音频生成失败，请检查TTS服务。', 'error');
                handleStopClick();
                return;
            }

            if (playbackQueue.length === 0) {
                showNotification('所有对话都生成失败，请检查TTS服务。', 'error');
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
            console.error('播放任务失败:', error);
            if (isPlaying) {
                showNotification(`播放失败: ${error.message}`, 'error');
                handleStopClick();
            }
            isProcessingQueue = false;
        }
    }

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

    // 前端美化适配函数
    async function forceDetectCurrentMessageAdapted() {
        return { success: false, totalParts: 0, message: '前端适配功能暂未移植' };
    }

    // 观察聊天内容
    function observeChat() {
        const validDialogueRegex = /[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff]/;
        let debounceTimer;

        const observerCallback = (mutations, observer) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                const messages = document.querySelectorAll('div.mes[is_user="false"]');
                if (messages.length === 0) return;

                const lastMessageElement = messages[messages.length - 1];
                const messageTextElement = lastMessageElement.querySelector('.mes_text');
                if (!messageTextElement) return;

                const messageId = lastMessageElement.getAttribute('mesid') ||
                    lastMessageElement.textContent.substring(0, 50);
                let fullText = messageTextElement.innerText;

                if (lastProcessedMessageId === messageId && lastProcessedText === fullText) return;

                lastProcessedMessageId = messageId;
                lastProcessedText = fullText;

                await reparseCurrentMessage();

                if (autoPlayEnabled && !isPlaying && lastMessageParts.length > 0) {
                    if (autoPlayTimeout) {
                        clearTimeout(autoPlayTimeout);
                        autoPlayTimeout = null;
                    }
                    autoPlayTimeout = setTimeout(() => {
                        if (!isPlaying && lastMessageParts.length > 0) {
                            handlePlayPauseResumeClick();
                        }
                    }, 800);
                }
            }, 300);
        };

        const observer = new MutationObserver(observerCallback);

        const interval = setInterval(() => {
            const chatContainer = document.querySelector('#chat');
            if (chatContainer) {
                observer.observe(chatContainer, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
                clearInterval(interval);
                reparseCurrentMessage();
            }
        }, 500);
    }

    // 使面板可拖拽
    function makeDraggable(panel) {
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        panel.addEventListener('mousedown', (e) => {
            if (e.target.closest('button, input, select, .tts-control-btn')) return;

            isDragging = true;
            panel.classList.add('dragging');

            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            const newLeft = startLeft + deltaX;
            const newTop = startTop + deltaY;

            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
            panel.style.right = 'auto';
            panel.style.transform = 'none';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                panel.classList.remove('dragging');
            }
        });
    }

    // 边缘隐藏功能
    function toggleEdgeHidden() {
        const panel = document.getElementById('tts-floating-panel');
        const indicator = document.getElementById('tts-edge-indicator');

        if (!panel) return;

        isEdgeHidden = !isEdgeHidden;

        if (isEdgeHidden) {
            originalPosition = {
                left: panel.style.left,
                top: panel.style.top,
                right: panel.style.right,
                transform: panel.style.transform
            };
            panel.classList.add('edge-hidden');
            if (!indicator) {
                createEdgeIndicator();
            } else {
                indicator.style.display = 'flex';
            }
        } else {
            panel.classList.remove('edge-hidden');
            if (indicator) {
                indicator.style.display = 'none';
            }
        }

        Settings.save();
    }

    // 创建边缘指示器
    function createEdgeIndicator() {
        const indicator = document.createElement('div');
        indicator.id = 'tts-edge-indicator';
        indicator.className = 'tts-edge-indicator';
        indicator.innerHTML = '◀';
        indicator.title = '点击展开TTS控制面板';

        indicator.addEventListener('click', () => {
            toggleEdgeHidden();
        });

        document.body.appendChild(indicator);
    }

    // 创建UI
    function createUI() {
        if (document.getElementById('tts-floating-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'tts-floating-panel';
        panel.className = 'tts-panel';

        const mainControls = document.createElement('div');
        mainControls.className = 'tts-main-controls';

        // 播放按钮
        const playBtn = document.createElement('button');
        playBtn.id = 'tts-play-btn';
        playBtn.className = 'tts-control-btn primary';
        playBtn.innerHTML = '<i class="icon">▶</i><span class="text">播放</span>';
        playBtn.disabled = true;
        playBtn.addEventListener('click', handlePlayPauseResumeClick);

        // 停止按钮
        const stopBtn = document.createElement('button');
        stopBtn.id = 'tts-stop-btn';
        stopBtn.className = 'tts-control-btn danger';
        stopBtn.innerHTML = '<i class="icon">⏹</i><span class="text">停止</span>';
        stopBtn.style.display = 'none';
        stopBtn.addEventListener('click', handleStopClick);

        // 重播按钮
        const replayBtn = document.createElement('button');
        replayBtn.id = 'tts-replay-btn';
        replayBtn.className = 'tts-control-btn secondary';
        replayBtn.innerHTML = '<i class="icon">🔁</i><span class="text">重播</span>';
        replayBtn.disabled = true;
        replayBtn.addEventListener('click', handleReplayClick);

        // 重新推理按钮
        const reinferBtn = document.createElement('button');
        reinferBtn.id = 'tts-reinfer-btn';
        reinferBtn.className = 'tts-control-btn secondary';
        reinferBtn.innerHTML = '<i class="icon">🔄</i><span class="text">重推</span>';
        reinferBtn.disabled = true;
        reinferBtn.addEventListener('click', handleReinferClick);

        // 设置按钮
        const settingsBtn = document.createElement('button');
        settingsBtn.id = 'tts-settings-btn';
        settingsBtn.className = 'tts-control-btn settings';
        settingsBtn.innerHTML = '<i class="icon">⚙</i><span class="text">设置</span>';
        settingsBtn.addEventListener('click', createSettingsPanel);

        // 边缘隐藏按钮
        const edgeHideBtn = document.createElement('button');
        edgeHideBtn.id = 'tts-edge-hide-btn';
        edgeHideBtn.className = 'tts-control-btn settings';
        edgeHideBtn.innerHTML = '<i class="icon">👁</i><span class="text">隐藏</span>';
        edgeHideBtn.addEventListener('click', toggleEdgeHidden);

        mainControls.appendChild(playBtn);
        mainControls.appendChild(stopBtn);
        mainControls.appendChild(replayBtn);
        mainControls.appendChild(reinferBtn);
        mainControls.appendChild(settingsBtn);
        mainControls.appendChild(edgeHideBtn);

        panel.appendChild(mainControls);
        document.body.appendChild(panel);

        makeDraggable(panel);
    }

    // 创建设置面板
    function createSettingsPanel() {
        const existingModal = document.getElementById('tts-settings-modal');
        if (existingModal) {
            existingModal.remove();
            return;
        }

        const modal = document.createElement('div');
        modal.id = 'tts-settings-modal';
        modal.className = 'tts-modal';

        const modalContent = document.createElement('div');
        modalContent.className = 'tts-modal-content';

        // 头部
        const header = document.createElement('div');
        header.className = 'tts-modal-header';
        header.innerHTML = `
            <h2><i class="icon">⚙</i> TTS设置 <span class="version">v1.0.0</span></h2>
            <div class="header-buttons">
                <button class="tts-close-btn">×</button>
            </div>
        `;

        // 主体
        const body = document.createElement('div');
        body.className = 'tts-modal-body';

        body.innerHTML = `
            <!-- 基础设置 -->
            <div class="tts-setting-section">
                <h3><i class="icon">🔧</i> 基础设置</h3>
                <div class="tts-setting-item">
                    <label>TTS API 地址</label>
                    <input type="text" id="tts-api-url" value="${ttsApiBaseUrl}" placeholder="http://127.0.0.1:8000">
                </div>
                <div class="tts-setting-item">
                    <label>API 版本</label>
                    <select id="tts-api-version">
                        <option value="v2" ${ttsApiVersion === 'v2' ? 'selected' : ''}>v2</option>
                        <option value="v3" ${ttsApiVersion === 'v3' ? 'selected' : ''}>v3</option>
                        <option value="v4" ${ttsApiVersion === 'v4' ? 'selected' : ''}>v4</option>
                    </select>
                </div>
                <div class="tts-setting-item" style="display: flex; gap: 10px;">
                    <button id="tts-test-connection" class="tts-test-btn">测试连接</button>
                    <button id="tts-refresh-models" class="tts-test-btn">刷新模型</button>
                </div>
            </div>

            <!-- 识别模式 -->
            <div class="tts-setting-section">
                <h3><i class="icon">🎯</i> 识别模式</h3>
                <div class="tts-radio-group">
                    <label class="tts-radio-item">
                        <input type="radio" name="detection-mode" value="character_and_dialogue" ${detectionMode === 'character_and_dialogue' ? 'checked' : ''}>
                        <span>【角色】「对话」</span>
                    </label>
                    <label class="tts-radio-item">
                        <input type="radio" name="detection-mode" value="character_emotion_and_dialogue" ${detectionMode === 'character_emotion_and_dialogue' ? 'checked' : ''}>
                        <span>【角色】〈情绪〉「对话」</span>
                    </label>
                    <label class="tts-radio-item">
                        <input type="radio" name="detection-mode" value="emotion_and_dialogue" ${detectionMode === 'emotion_and_dialogue' ? 'checked' : ''}>
                        <span>〈情绪〉「对话」</span>
                    </label>
                    <label class="tts-radio-item">
                        <input type="radio" name="detection-mode" value="narration_and_dialogue" ${detectionMode === 'narration_and_dialogue' ? 'checked' : ''}>
                        <span>旁白与对话</span>
                    </label>
                    <label class="tts-radio-item">
                        <input type="radio" name="detection-mode" value="dialogue_only" ${detectionMode === 'dialogue_only' ? 'checked' : ''}>
                        <span>仅「对话」</span>
                    </label>
                    <label class="tts-radio-item">
                        <input type="radio" name="detection-mode" value="entire_message" ${detectionMode === 'entire_message' ? 'checked' : ''}>
                        <span>朗读整段</span>
                    </label>
                </div>
            </div>

            <!-- 语音设置 -->
            <div class="tts-setting-section">
                <h3><i class="icon">🎙️</i> 语音设置</h3>
                <div class="tts-setting-item">
                    <label>默认语音</label>
                    <select id="tts-default-voice" class="tts-voice-select">
                        <option value="">-- 选择语音 --</option>
                    </select>
                </div>
                <div class="tts-setting-item">
                    <label>默认情感</label>
                    <select id="tts-emotion-select">
                        <option value="默认">默认</option>
                    </select>
                </div>
                <div class="tts-setting-item">
                    <label>旁白语音</label>
                    <select id="tts-narration-voice" class="tts-voice-select">
                        <option value="">-- 选择语音 --</option>
                    </select>
                </div>
                <div class="tts-setting-item">
                    <label>对话语音</label>
                    <select id="tts-dialogue-voice" class="tts-voice-select">
                        <option value="">-- 选择语音 --</option>
                    </select>
                </div>
                <div class="tts-setting-item">
                    <label>语速 <span id="speed-value">${speedFacter.toFixed(1)}</span></label>
                    <input type="range" id="tts-speed" min="0.5" max="2.0" step="0.1" value="${speedFacter}">
                </div>
            </div>

            <!-- 功能开关 -->
            <div class="tts-setting-section">
                <h3><i class="icon">⚡</i> 功能设置</h3>
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
                    <p class="tts-setting-desc">启用后可从juus本体等美化前端中解析文本</p>
                </div>
            </div>

            <!-- 引号样式 -->
            <div class="tts-setting-section">
                <h3><i class="icon">📝</i> 引号样式</h3>
                <div class="tts-toggle-group">
                    <label class="tts-toggle-item ${quotationStyle === 'japanese' ? 'active' : ''}">
                        <input type="radio" name="quotation-style" value="japanese" ${quotationStyle === 'japanese' ? 'checked' : ''}>
                        <span>日式「」</span>
                    </label>
                    <label class="tts-toggle-item ${quotationStyle === 'western' ? 'active' : ''}">
                        <input type="radio" name="quotation-style" value="western" ${quotationStyle === 'western' ? 'checked' : ''}>
                        <span>西式""</span>
                    </label>
                </div>
            </div>

            <!-- 检测到的角色 -->
            <div class="tts-setting-section">
                <h3><i class="icon">👥</i> 检测到的角色</h3>
                <div id="tts-character-list">
                    ${allDetectedCharacters.size === 0 ? '<p class="tts-empty-state">暂无检测到的角色</p>' : ''}
                </div>
            </div>
        `;

        modalContent.appendChild(header);
        modalContent.appendChild(body);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);

        // 填充语音选择
        setTimeout(() => {
            populateVoiceSelects();

            // 设置当前值
            const defaultVoiceSelect = document.getElementById('tts-default-voice');
            const narrationVoiceSelect = document.getElementById('tts-narration-voice');
            const dialogueVoiceSelect = document.getElementById('tts-dialogue-voice');

            if (defaultVoiceSelect) defaultVoiceSelect.value = defaultVoice;
            if (narrationVoiceSelect) narrationVoiceSelect.value = narrationVoice;
            if (dialogueVoiceSelect) dialogueVoiceSelect.value = dialogueVoice;

            updateEmotionSelect(defaultVoice);
            renderCharacterList();
        }, 100);

        // 事件绑定
        bindSettingsEvents(modal);
    }

    // 渲染角色列表
    function renderCharacterList() {
        const container = document.getElementById('tts-character-list');
        if (!container) return;

        if (allDetectedCharacters.size === 0) {
            container.innerHTML = '<p class="tts-empty-state">暂无检测到的角色</p>';
            return;
        }

        container.innerHTML = '';
        allDetectedCharacters.forEach(character => {
            const voiceSetting = characterVoices[character];
            const currentVoice = typeof voiceSetting === 'object' ? voiceSetting.voice : voiceSetting;
            const currentVersion = typeof voiceSetting === 'object' ? voiceSetting.version : ttsApiVersion;
            const currentSpeed = typeof voiceSetting === 'object' ? (voiceSetting.speed || 1.0) : 1.0;

            const item = document.createElement('div');
            item.className = 'tts-character-item';
            item.innerHTML = `
                <div class="tts-character-header">
                    <span class="character-name">${character}</span>
                    <button class="tts-delete-char" data-character="${character}">×</button>
                </div>
                <div class="tts-character-controls">
                    <select class="tts-character-voice tts-voice-select" data-character="${character}">
                        <option value="">-- 选择语音 --</option>
                        <option value="${DO_NOT_PLAY_VALUE}" ${currentVoice === DO_NOT_PLAY_VALUE ? 'selected' : ''}>不播放</option>
                    </select>
                    <select class="tts-character-version" data-character="${character}">
                        <option value="v2" ${currentVersion === 'v2' ? 'selected' : ''}>v2</option>
                        <option value="v3" ${currentVersion === 'v3' ? 'selected' : ''}>v3</option>
                        <option value="v4" ${currentVersion === 'v4' ? 'selected' : ''}>v4</option>
                    </select>
                    <div class="tts-character-speed-control">
                        <label>语速: <span class="tts-character-speed-value">${currentSpeed.toFixed(1)}</span></label>
                        <input type="range" class="tts-character-speed-slider" data-character="${character}" 
                               min="0.5" max="2.0" step="0.1" value="${currentSpeed}">
                    </div>
                </div>
            `;
            container.appendChild(item);

            // 填充语音选项
            const voiceSelect = item.querySelector('.tts-character-voice');
            ttsModels.forEach(model => {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                if (model === currentVoice) option.selected = true;
                voiceSelect.appendChild(option);
            });

            // 角色语音变更
            voiceSelect.addEventListener('change', (e) => {
                const char = e.target.dataset.character;
                const versionSelect = item.querySelector('.tts-character-version');
                const speedSlider = item.querySelector('.tts-character-speed-slider');

                characterVoices[char] = {
                    voice: e.target.value,
                    version: versionSelect.value,
                    speed: parseFloat(speedSlider.value)
                };
                Settings.save();
            });

            // 角色版本变更
            item.querySelector('.tts-character-version').addEventListener('change', (e) => {
                const char = e.target.dataset.character;
                const voiceSelect = item.querySelector('.tts-character-voice');
                const speedSlider = item.querySelector('.tts-character-speed-slider');

                characterVoices[char] = {
                    voice: voiceSelect.value,
                    version: e.target.value,
                    speed: parseFloat(speedSlider.value)
                };
                Settings.save();
            });

            // 角色语速变更
            item.querySelector('.tts-character-speed-slider').addEventListener('input', (e) => {
                const char = e.target.dataset.character;
                const speedValue = item.querySelector('.tts-character-speed-value');
                speedValue.textContent = parseFloat(e.target.value).toFixed(1);

                const voiceSelect = item.querySelector('.tts-character-voice');
                const versionSelect = item.querySelector('.tts-character-version');

                characterVoices[char] = {
                    voice: voiceSelect.value,
                    version: versionSelect.value,
                    speed: parseFloat(e.target.value)
                };
                Settings.save();
            });

            // 删除角色
            item.querySelector('.tts-delete-char').addEventListener('click', (e) => {
                const char = e.target.dataset.character;
                allDetectedCharacters.delete(char);
                delete characterVoices[char];
                Settings.save();
                renderCharacterList();
            });
        });
    }

    // 绑定设置事件
    function bindSettingsEvents(modal) {
        // 关闭按钮
        modal.querySelector('.tts-close-btn').addEventListener('click', () => {
            modal.remove();
        });

        // 点击背景关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });

        // API地址变更
        const apiUrlInput = document.getElementById('tts-api-url');
        apiUrlInput.addEventListener('change', () => {
            ttsApiBaseUrl = apiUrlInput.value.replace(/\/$/, '');
            updateApiEndpoints();
            Settings.save();
        });

        // API版本变更
        const apiVersionSelect = document.getElementById('tts-api-version');
        apiVersionSelect.addEventListener('change', () => {
            ttsApiVersion = apiVersionSelect.value;
            Settings.save();
            fetchTTSModels();
        });

        // 测试连接
        document.getElementById('tts-test-connection').addEventListener('click', async () => {
            try {
                showNotification('正在测试连接...', 'info');
                const response = await makeRequest(TTS_API_ENDPOINT_MODELS, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    data: JSON.stringify({ version: ttsApiVersion }),
                    timeout: 5000
                });
                if (response.status === 200) {
                    showNotification('连接成功！', 'success');
                } else {
                    showNotification(`连接失败: ${response.status}`, 'error');
                }
            } catch (error) {
                showNotification(`连接失败: ${error.message}`, 'error');
            }
        });

        // 刷新模型
        document.getElementById('tts-refresh-models').addEventListener('click', () => {
            fetchTTSModels();
        });

        // 识别模式变更
        document.querySelectorAll('input[name="detection-mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                detectionMode = e.target.value;
                Settings.save();
                reparseCurrentMessage();
            });
        });

        // 默认语音变更
        document.getElementById('tts-default-voice').addEventListener('change', (e) => {
            defaultVoice = e.target.value;
            updateEmotionSelect(defaultVoice);
            Settings.save();
        });

        // 情感变更
        document.getElementById('tts-emotion-select').addEventListener('change', (e) => {
            emotion = e.target.value;
            Settings.save();
        });

        // 旁白语音变更
        document.getElementById('tts-narration-voice').addEventListener('change', (e) => {
            narrationVoice = e.target.value;
            Settings.save();
        });

        // 对话语音变更
        document.getElementById('tts-dialogue-voice').addEventListener('change', (e) => {
            dialogueVoice = e.target.value;
            Settings.save();
        });

        // 语速变更
        const speedSlider = document.getElementById('tts-speed');
        speedSlider.addEventListener('input', (e) => {
            speedFacter = parseFloat(e.target.value);
            document.getElementById('speed-value').textContent = speedFacter.toFixed(1);
            Settings.save();
        });

        // 自动播放变更
        document.getElementById('tts-auto-play').addEventListener('change', (e) => {
            autoPlayEnabled = e.target.checked;
            Settings.save();
        });

        // 前端适配变更
        document.getElementById('tts-frontend-adaptation').addEventListener('change', (e) => {
            frontendAdaptationEnabled = e.target.checked;
            Settings.save();
        });

        // 引号样式变更
        document.querySelectorAll('input[name="quotation-style"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                quotationStyle = e.target.value;
                document.querySelectorAll('.tts-toggle-item').forEach(item => {
                    item.classList.remove('active');
                });
                e.target.closest('.tts-toggle-item').classList.add('active');
                Settings.save();
                reparseCurrentMessage();
            });
        });
    }

    // 初始化
    async function init() {
        console.log('[GPT-SoVITS TTS] 初始化...');

        Settings.load();
        createUI();

        try {
            await fetchTTSModels();
        } catch (error) {
            console.error('[GPT-SoVITS TTS] 获取模型失败:', error);
        }

        observeChat();

        // 注入ST扩展设置入口
        try {
            const settingsHtmlUrl = `scripts/extensions/third-party/${EXTENSION_NAME}/settings.html`;
            const response = await fetch(settingsHtmlUrl);
            if (response.ok) {
                const html = await response.text();
                const extensionHtml = `
                    <div class="inline-drawer">
                        <div class="inline-drawer-toggle inline-drawer-header">
                            <b>GPT-SoVITS TTS Player</b>
                            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                        </div>
                        <div class="inline-drawer-content" style="display: none;">
                            ${html}
                        </div>
                    </div>`;

                const container = document.querySelector('#extensions_settings');
                if (container) {
                    container.insertAdjacentHTML('beforeend', extensionHtml);

                    // 绑定重置UI按钮
                    document.getElementById('st-gpt-sovits-reset-ui')?.addEventListener('click', () => {
                        const panel = document.getElementById('tts-floating-panel');
                        if (panel) {
                            panel.style.left = '';
                            panel.style.top = '50%';
                            panel.style.right = '20px';
                            panel.style.transform = 'translateY(-50%)';
                            showNotification('悬浮窗位置已重置', 'success');
                        }
                    });

                    // 绑定显示面板按钮
                    document.getElementById('st-gpt-sovits-show-panel')?.addEventListener('click', () => {
                        if (isEdgeHidden) {
                            toggleEdgeHidden();
                        }
                        const panel = document.getElementById('tts-floating-panel');
                        if (panel) {
                            panel.style.display = 'block';
                            showNotification('悬浮窗已显示', 'success');
                        }
                    });
                }
            }
        } catch (error) {
            console.error('[GPT-SoVITS TTS] 加载settings.html失败:', error);
        }

        console.log('[GPT-SoVITS TTS] 初始化完成');
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
