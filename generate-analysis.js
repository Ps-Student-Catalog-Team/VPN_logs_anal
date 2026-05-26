const fs = require('fs');
const path = require('path');

// ==================== 配置部分 ====================
const CONFIG = {
    // 是否保存session详细信息（true时会占用大量内存）
    storeSessions: true,
    // 时区（UTC 或 local）
    timezone: 'local',
    // 并行处理月份数
    parallelMonths: 10,
    // Markdown文件缓冲区大小（字节）
    markdownBufferSize: 64 * 1024, // 64KB
    // 是否启用跳过已分析日志（--force 可强制重新分析）
    skipAnalyzed: true
};

// ==================== 预编译的正则表达式 ====================
const REGEX = {
    // 日期标题
    dateTitle: /## vpn_20(\d{6})\.log/,
    // 表格行（非标题行和分隔线）
    tableLine: /^\|/,
    // 连接建立
    connEstablished: /连接 "(CID-\d+)" 已建立/,
    // IP地址
    ipAddress: /IP 地址[:：] *(\d+\.\d+\.\d+\.\d+)/,
    // 会话创建
    sessionCreate: /连接 "(CID-\d+)": 已创建新会话 "(SID-[^"]+)"/,
    // 协议信息
    protocol: /物理底层协议："([^"]+)"/,
    // 会话结束
    sessionEnd: /会话 "(SID-[^"]+)": 会话已结束。统计信息如下: 总输出数据大小: (\d+) 字节，总输入数据大小: (\d+) 字节/,
    // 数字提取
    number: /([\d.]+)/
};

// ==================== 工具函数 ====================

/**
 * 合并日志数据
 * @param {Object} targetData - 目标数据对象
 * @param {Object} sourceData - 源数据对象
 * @param {Boolean} storeSessions - 是否保存session信息
 */
function mergeLogData(targetData, sourceData, storeSessions = CONFIG.storeSessions) {
    targetData.connections += sourceData.connections;
    targetData.totalData += sourceData.totalData;
    targetData.totalDuration += sourceData.totalDuration;
    
    // 合并IP统计
    for (const [ip, stats] of Object.entries(sourceData.ipStats)) {
        if (!targetData.ipStats[ip]) {
            targetData.ipStats[ip] = {
                connections: stats.connections,
                totalDuration: stats.totalDuration,
                totalData: stats.totalData,
                vpnProtocols: { ...stats.vpnProtocols },
                sessions: storeSessions && stats.sessions ? [...stats.sessions] : []
            };
        } else {
            targetData.ipStats[ip].connections += stats.connections;
            targetData.ipStats[ip].totalDuration += stats.totalDuration;
            targetData.ipStats[ip].totalData += stats.totalData;
            
            // 合并VPN协议统计
            for (const [proto, count] of Object.entries(stats.vpnProtocols)) {
                targetData.ipStats[ip].vpnProtocols[proto] = 
                    (targetData.ipStats[ip].vpnProtocols[proto] || 0) + count;
            }
            
            // 合并会话信息
            if (storeSessions && stats.sessions && Array.isArray(stats.sessions)) {
                targetData.ipStats[ip].sessions.push(...stats.sessions);
            }
        }
    }
    
    // 合并VPN协议统计
    for (const [proto, count] of Object.entries(sourceData.vpnProtocolStats)) {
        targetData.vpnProtocolStats[proto] = (targetData.vpnProtocolStats[proto] || 0) + count;
    }
    
    // 合并时间统计
    for (let h = 0; h < 24; h++) {
        targetData.timeStats[h] += sourceData.timeStats[h];
    }
    
    // 合并每日统计
    for (const [date, daily] of Object.entries(sourceData.dailyStats)) {
        if (!targetData.dailyStats[date]) {
            targetData.dailyStats[date] = {
                connections: daily.connections,
                totalDuration: daily.totalDuration,
                totalData: daily.totalData
            };
        } else {
            targetData.dailyStats[date].connections += daily.connections;
            targetData.dailyStats[date].totalDuration += daily.totalDuration;
            targetData.dailyStats[date].totalData += daily.totalData;
        }
    }
}

/**
 * 初始化空的日志数据对象
 */
function createEmptyLogData() {
    return {
        connections: 0,
        uniqueIps: 0,
        totalData: 0,
        totalDuration: 0,
        avgDuration: 0,
        ipStats: {},
        vpnProtocolStats: {},
        timeStats: Array(24).fill(0),
        dailyStats: {}
    };
}

/**
 * 完成日志数据计算
 */
function finalizeLogData(logData) {
    logData.uniqueIps = Object.keys(logData.ipStats).length;
    logData.avgDuration = logData.connections ? logData.totalDuration / logData.connections : 0;
}

/**
 * 将时间戳应用时区转换
 * @param {string} dateStr - 日期字符串（YYYY-MM-DD）
 * @returns {Date} - 转换后的日期
 */
function applyTimezone(dateStr) {
    if (CONFIG.timezone === 'local') {
        return new Date(dateStr + 'T00:00:00');
    } else if (CONFIG.timezone === 'UTC') {
        return new Date(dateStr + 'T00:00:00Z');
    }
    return new Date(dateStr + 'T00:00:00');
}

/**
 * 解析日期时间字符串并应用时区
 * @param {string} dateTimeStr - 日期时间字符串（YYYY-MM-DD HH:MM:SS）
 * @returns {Date} - 转换后的日期
 */
function parseDateTime(dateTimeStr) {
    if (CONFIG.timezone === 'local') {
        return new Date(dateTimeStr.replace(' ', 'T'));
    } else if (CONFIG.timezone === 'UTC') {
        return new Date(dateTimeStr.replace(' ', 'T') + 'Z');
    }
    return new Date(dateTimeStr.replace(' ', 'T'));
}

// 分析日志文件的函数
async function analyzeLogFile(filePath) {
    try {
        const logData = createEmptyLogData();
        
        // 检查文件扩展名
        if (filePath.endsWith('.md')) {
            // 使用流式读取解析 Markdown 文件
            const readStream = fs.createReadStream(filePath, {
                encoding: 'utf8',
                highWaterMark: CONFIG.markdownBufferSize
            });
            
            let buffer = '';
            let currentDate = null;
            
            for await (const chunk of readStream) {
                buffer += chunk;
                let lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    const trimmed = line.trim();
                    
                    // 检测日期标题
                    const dateMatch = trimmed.match(REGEX.dateTitle);
                    if (dateMatch) {
                        const dateStr = dateMatch[1];
                        currentDate = `20${dateStr.substring(0, 2)}-${dateStr.substring(2, 4)}-${dateStr.substring(4, 6)}`;
                        continue;
                    }
                    
                    // 检测表格行
                    if (currentDate && REGEX.tableLine.test(trimmed) && !trimmed.includes('| IP地址 |') && !trimmed.includes('|---------|')) {
                        const parts = trimmed.split('|').map(p => p.trim()).filter(p => p);
                        if (parts.length >= 4) {
                            const ip = parts[0];
                            const startTime = parts[1];
                            const endTime = parts[2];
                            const durationStr = parts[3];
                            const vpnProtocol = parts[4] || '未知';
                            
                            // 解析持续时间（秒转换为分钟）
                            let duration = 0;
                            const durationMatch = durationStr.match(REGEX.number);
                            if (durationMatch) {
                                duration = parseFloat(durationMatch[1]) / 60;
                            }
                            
                            // 初始化IP统计
                            if (!logData.ipStats[ip]) {
                                logData.ipStats[ip] = {
                                    connections: 0,
                                    totalDuration: 0,
                                    totalData: 0,
                                    vpnProtocols: {},
                                    sessions: []
                                };
                            }
                            
                            const stats = logData.ipStats[ip];
                            stats.connections++;
                            stats.totalDuration += duration;
                            stats.vpnProtocols[vpnProtocol] = (stats.vpnProtocols[vpnProtocol] || 0) + 1;
                            
                            logData.connections++;
                            logData.totalDuration += duration;
                            logData.vpnProtocolStats[vpnProtocol] = (logData.vpnProtocolStats[vpnProtocol] || 0) + 1;
                            
                            if (!logData.dailyStats[currentDate]) {
                                logData.dailyStats[currentDate] = { connections: 0, totalDuration: 0, totalData: 0 };
                            }
                            logData.dailyStats[currentDate].connections++;
                            logData.dailyStats[currentDate].totalDuration += duration;
                            
                            if (startTime && startTime.includes(' ')) {
                                const hour = parseDateTime(startTime).getHours();
                                if (!isNaN(hour)) {
                                    logData.timeStats[hour]++;
                                }
                            }
                            
                            // ========== 关键修改：启用会话详情存储 ==========
                            if (CONFIG.storeSessions) {   // 需要将 CONFIG.storeSessions 设为 true
                                const session = {
                                    sessionId: `SID-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                                    ip: ip,
                                    vpnProtocol: vpnProtocol,
                                    startTime: startTime,
                                    endTime: endTime,
                                    duration: duration,
                                    inputData: 0,
                                    outputData: 0
                                };
                                stats.sessions.push(session);
                            }
                        }
                    }
                }
            }
            
            // 处理最后缓冲区（省略，逻辑与上面相同，也需包含会话存储）
            // ...
        } else {
            // 解析普通日志文件（.log）
            const activeSessions = {};
            const connToSessionMap = {};
            
            const readStream = fs.createReadStream(filePath, 'utf8');
            let buffer = '';
            
            for await (const chunk of readStream) {
                buffer += chunk;
                let lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (const line of lines) {
                    // 连接建立
                    const connMatch = line.match(REGEX.connEstablished);
                    if (connMatch) {
                        const connId = connMatch[1];
                        const ipMatch = line.match(REGEX.ipAddress);
                        const ip = ipMatch ? ipMatch[1] : '未知IP';
                        const timestamp = line.substring(0, 19);
                        connToSessionMap[connId] = { ip, startTime: timestamp };
                        continue;
                    }
                    
                    // 会话创建
                    const sessionCreateMatch = line.match(REGEX.sessionCreate);
                    if (sessionCreateMatch) {
                        const connId = sessionCreateMatch[1];
                        const sessionId = sessionCreateMatch[2];
                        const connInfo = connToSessionMap[connId];
                        if (connInfo) {
                            const protoMatch = line.match(REGEX.protocol);
                            let vpnProtocol = protoMatch ? protoMatch[1] : '未知协议';
                            // 简化协议名称
                            if (vpnProtocol.includes('OPENVPN')) vpnProtocol = 'OpenVPN';
                            else if (vpnProtocol.includes('L2TP')) vpnProtocol = 'L2TP';
                            else if (vpnProtocol.includes('SSTP')) vpnProtocol = 'SSTP';
                            else if (vpnProtocol.includes('IPsec') || vpnProtocol.includes('IKEv2')) vpnProtocol = 'IPsec';
                            else if (vpnProtocol.includes('EtherIP')) vpnProtocol = 'EtherIP';
                            
                            activeSessions[sessionId] = {
                                sessionId: sessionId,
                                connectionId: connId,
                                ip: connInfo.ip,
                                vpnProtocol: vpnProtocol,
                                startTime: connInfo.startTime,
                                endTime: null,
                                duration: 0,
                                inputData: 0,
                                outputData: 0
                            };
                            
                            const hour = parseDateTime(connInfo.startTime).getHours();
                            logData.timeStats[hour]++;
                            
                            if (!logData.ipStats[connInfo.ip]) {
                                logData.ipStats[connInfo.ip] = {
                                    connections: 0,
                                    totalDuration: 0,
                                    totalData: 0,
                                    vpnProtocols: {},
                                    sessions: []
                                };
                            }
                            
                            logData.vpnProtocolStats[vpnProtocol] = (logData.vpnProtocolStats[vpnProtocol] || 0) + 1;
                            logData.ipStats[connInfo.ip].vpnProtocols[vpnProtocol] = 
                                (logData.ipStats[connInfo.ip].vpnProtocols[vpnProtocol] || 0) + 1;
                            
                            delete connToSessionMap[connId];
                        }
                        continue;
                    }
                    
                    // 会话结束
                    const endMatch = line.match(REGEX.sessionEnd);
                    if (endMatch) {
                        const sessionId = endMatch[1];
                        const output = parseInt(endMatch[2]);
                        const input = parseInt(endMatch[3]);
                        const session = activeSessions[sessionId];
                        if (session) {
                            session.endTime = line.substring(0, 19);
                            const startDate = parseDateTime(session.startTime);
                            const endDate = parseDateTime(session.endTime);
                            session.duration = (endDate - startDate) / (1000 * 60);
                            session.inputData = input;
                            session.outputData = output;
                            
                            const stats = logData.ipStats[session.ip];
                            if (stats) {
                                stats.connections++;
                                stats.totalDuration += session.duration;
                                stats.totalData += input + output;
                                // ========== 存储会话详情 ==========
                                if (CONFIG.storeSessions) {
                                    stats.sessions.push({ ...session });
                                }
                            }
                            
                            logData.connections++;
                            logData.totalDuration += session.duration;
                            logData.totalData += input + output;
                            
                            const date = session.startTime.substring(0, 10);
                            if (!logData.dailyStats[date]) {
                                logData.dailyStats[date] = { connections: 0, totalDuration: 0, totalData: 0 };
                            }
                            logData.dailyStats[date].connections++;
                            logData.dailyStats[date].totalDuration += session.duration;
                            logData.dailyStats[date].totalData += input + output;
                            
                            delete activeSessions[sessionId];
                        }
                    }
                }
            }
            
            // 处理未结束的会话（可选，标记为不完整）
            for (const [sessionId, session] of Object.entries(activeSessions)) {
                if (session && session.ip) {
                    const stats = logData.ipStats[session.ip];
                    if (stats) {
                        stats.connections++;
                        if (CONFIG.storeSessions) {
                            stats.sessions.push({
                                ...session,
                                duration: 0,
                                isIncomplete: true
                            });
                        }
                    }
                    const date = session.startTime.substring(0, 10);
                    if (!logData.dailyStats[date]) {
                        logData.dailyStats[date] = { connections: 0, totalDuration: 0, totalData: 0 };
                    }
                    logData.dailyStats[date].connections++;
                    logData.connections++;
                }
            }
        }
        
        finalizeLogData(logData);
        return logData;
    } catch (error) {
        console.error(`分析文件 ${filePath} 失败:`, error);
        return null;
    }
}

// 检测存在的月份（动态识别年份）
function detectExistingMonths() {
    const existing = new Set();
    
    try {
        const entries = fs.readdirSync(__dirname, { withFileTypes: true });
        
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            
            const dirName = entry.name;
            // 匹配格式：YYMM（如2502、2603）
            const match = dirName.match(/^(\d{2})(\d{2})$/);
            if (match) {
                const year = match[1];
                const month = parseInt(match[2]);
                
                // 验证月份合理性
                if (month >= 1 && month <= 12) {
                    existing.add(dirName);
                }
            }
        }
    } catch (error) {
        console.error('检测存在的月份失败:', error);
    }
    
    return Array.from(existing).sort();
}

/**
 * 获取指定月份的所有日志文件及其最新修改时间
 * @param {string} monthFolder - 月份文件夹名 (如 2502)
 * @returns {{ files: string[], latestMtime: number }} 文件路径数组和最新mtime（毫秒），无文件时 latestMtime = 0
 */
function getFilesInMonth(monthFolder) {
    const folderPath = path.join(__dirname, monthFolder);
    const files = [];
    let latestMtime = 0;
    
    if (!fs.existsSync(folderPath)) {
        return { files, latestMtime: 0 };
    }
    
    // 优先检查 .md 文件（整个月份汇总）
    const mdFilePath = path.join(folderPath, `${monthFolder}.md`);
    if (fs.existsSync(mdFilePath)) {
        files.push(mdFilePath);
        try {
            const stat = fs.statSync(mdFilePath);
            latestMtime = Math.max(latestMtime, stat.mtimeMs);
        } catch (err) {}
        return { files, latestMtime };
    }
    
    // 没有 .md，则收集所有 .log 文件
    const year = monthFolder.slice(0, 2);
    const month = monthFolder.slice(2);
    const days = new Date(parseInt(year) + 2000, parseInt(month), 0).getDate();
    
    for (let d = 1; d <= days; d++) {
        const dd = d.toString().padStart(2, '0');
        const fileName = `vpn_20${year}${month}${dd}.log`;
        const filePath = path.join(folderPath, fileName);
        
        if (fs.existsSync(filePath)) {
            files.push(filePath);
            try {
                const stat = fs.statSync(filePath);
                latestMtime = Math.max(latestMtime, stat.mtimeMs);
            } catch (err) {}
        }
    }
    
    return { files, latestMtime };
}

/**
 * 从缓存的 JSON 文件加载月份分析结果
 * @param {string} month - 月份文件夹名
 * @returns {Object|null} 日志数据对象，失败返回 null
 */
function loadMonthCache(month) {
    const jsonPath = path.join(__dirname, 'analysis', `${month}.json`);
    if (!fs.existsSync(jsonPath)) return null;
    try {
        const content = fs.readFileSync(jsonPath, 'utf8');
        return JSON.parse(content);
    } catch (err) {
        console.error(`读取缓存文件 ${jsonPath} 失败:`, err);
        return null;
    }
}

/**
 * 检查某月份的缓存是否仍然有效（基于源文件修改时间）
 * @param {string} month - 月份文件夹名
 * @param {number} latestSourceMtime - 该月份内所有日志文件的最新修改时间（毫秒）
 * @returns {boolean} true 表示缓存有效可跳过，false 表示需要重新分析
 */
function isMonthCacheValid(month, latestSourceMtime) {
    if (!CONFIG.skipAnalyzed) return false;
    if (latestSourceMtime === 0) {
        // 没有源文件，但如果有缓存则也算"有效"，避免重复报错
        const jsonPath = path.join(__dirname, 'analysis', `${month}.json`);
        return fs.existsSync(jsonPath);
    }
    const jsonPath = path.join(__dirname, 'analysis', `${month}.json`);
    if (!fs.existsSync(jsonPath)) return false;
    try {
        const jsonStat = fs.statSync(jsonPath);
        return jsonStat.mtimeMs >= latestSourceMtime;
    } catch (err) {
        return false;
    }
}

// 分析单月日志
async function analyzeSingleMonth(month, forceRebuild = false) {
    console.log(`分析单月: ${month}`);
    const { files, latestMtime } = getFilesInMonth(month);
    
    // 如果启用缓存且未强制重建，检查缓存有效性
    if (!forceRebuild && CONFIG.skipAnalyzed && isMonthCacheValid(month, latestMtime)) {
        const cached = loadMonthCache(month);
        if (cached) {
            console.log(`  跳过 ${month}，使用已有缓存 (源文件未变化)`);
            return cached;
        }
    }
    
    if (files.length === 0) {
        // 没有源文件但可能有旧缓存，如果缓存存在则返回（已被上层检查过）
        console.log(`没有找到 ${month} 月份的日志文件`);
        return null;
    }
    
    const monthLogData = createEmptyLogData();
    
    for (const file of files) {
        const fileLogData = await analyzeLogFile(file);
        if (fileLogData) {
            mergeLogData(monthLogData, fileLogData, CONFIG.storeSessions);
        }
    }
    
    finalizeLogData(monthLogData);
    return monthLogData;
}

// 分析单年日志
async function analyzeSingleYear(year, forceRebuild = false) {
    console.log(`分析单年: 20${year}`);
    const existingMonths = detectExistingMonths();
    const yearMonths = existingMonths.filter(month => month.startsWith(year));
    
    if (yearMonths.length === 0) {
        console.log(`没有找到 ${year} 年份的日志文件`);
        return null;
    }
    
    const yearLogData = createEmptyLogData();
    
    for (const month of yearMonths) {
        const monthLogData = await analyzeSingleMonth(month, forceRebuild);
        if (monthLogData) {
            mergeLogData(yearLogData, monthLogData, CONFIG.storeSessions);
        }
    }
    
    finalizeLogData(yearLogData);
    return yearLogData;
}

// 分析全部日志
async function analyzeAllLogs(forceRebuild = false) {
    console.log('分析全部日志');
    const existingMonths = detectExistingMonths();
    
    if (existingMonths.length === 0) {
        console.log('没有找到任何日志文件');
        return null;
    }
    
    const allLogData = createEmptyLogData();
    
    for (const month of existingMonths) {
        const monthLogData = await analyzeSingleMonth(month, forceRebuild);
        if (monthLogData) {
            mergeLogData(allLogData, monthLogData, CONFIG.storeSessions);
        }
    }
    
    finalizeLogData(allLogData);
    return allLogData;
}

// 保存分析结果为JSON文件
function saveAnalysisResult(filePath, data) {
    try {
        // 确保目录存在
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log(`分析结果已保存到: ${filePath}`);
    } catch (error) {
        console.error(`保存分析结果失败:`, error);
    }
}

// 主函数
async function main() {
    // 解析命令行参数，支持 --force 强制重新分析所有月份
    const forceRebuild = process.argv.includes('--force');
    if (forceRebuild) {
        console.log('⚠️  强制重建模式：将忽略所有缓存，重新分析全部日志');
        CONFIG.skipAnalyzed = false;
    } else {
        console.log(` 启用缓存：未变化的月份将直接使用已有分析结果（使用 --force 可强制重建）`);
    }
    
    console.log('开始生成分析文件...');
    console.log(`配置: storeSessions=${CONFIG.storeSessions}, timezone=${CONFIG.timezone}`);
    
    // 检测存在的月份
    const existingMonths = detectExistingMonths();
    console.log(`检测到的月份: ${existingMonths.join(', ')}`);
    
    // 保存存在的月份到文件
    saveAnalysisResult(path.join(__dirname, 'analysis', 'existing-months.json'), { 
    months: existingMonths,
    all: true   
});
    
    // 并行处理月份分析（按配置的并行度）
    console.log(`使用并行度 ${CONFIG.parallelMonths} 处理月份...`);
    for (let i = 0; i < existingMonths.length; i += CONFIG.parallelMonths) {
        const batch = existingMonths.slice(i, i + CONFIG.parallelMonths);
        const promises = batch.map(async (month) => {
            const monthData = await analyzeSingleMonth(month, forceRebuild);
            if (monthData) {
                saveAnalysisResult(path.join(__dirname, 'analysis', `${month}.json`), monthData);
            }
        });
        await Promise.all(promises);
    }
    
    // 分析单年日志
    const years = [...new Set(existingMonths.map(month => month.slice(0, 2)))];
    for (const year of years) {
        const yearData = await analyzeSingleYear(year, forceRebuild);
        if (yearData) {
            saveAnalysisResult(path.join(__dirname, 'analysis', `${year}.json`), yearData);
        }
    }
    
    // 分析全部日志
    const allData = await analyzeAllLogs(forceRebuild);
    if (allData) {
        saveAnalysisResult(path.join(__dirname, 'analysis', 'all.json'), allData);
    }
    
    console.log('分析文件生成完成!');
}

// 运行主函数
main().catch(console.error);