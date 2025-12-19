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
    characterVoices = settings.characterVoices;
    defaultVoice = settings.defaultVoice;
    allDetectedCharacters = new Set(settings.allDetectedCharacters || []);
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
                        <div class="tts-setting-item"><label>默认语音</label><select id="tts-default-voice" class="tts-voice-select"></select></div>
                        <div class="tts-setting-item"><label>旁白语音</label><select id="tts-narration-voice" class="tts-voice-select"></select></div>
                        <div class="tts-setting-item"><label>对话语音</label><select id="tts-dialogue-voice" class="tts-voice-select"></select></div>
                        <div class="tts-setting-item"><label>默认情感</label><select id="tts-emotion-select"><option value="默认">默认</option></select></div>
                        <div class="tts-setting-item"><label>语速 <span id="speed-value">${speedFacter.toFixed(1)}</span></label><input type="range" id="tts-speed" min="0.5" max="2.0" step="0.1" value="${speedFacter}"></div>
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
                    
                    <div class="tts-setting-section">
                        <h3>👥 检测到的角色</h3>
                        <div id="tts-character-list">${characterListHtml}</div>
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
    $('input[name="detection-mode"]').on('change', function () { detectionMode = $(this).val(); saveSettings(); reparseCurrentMessage(); });

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
