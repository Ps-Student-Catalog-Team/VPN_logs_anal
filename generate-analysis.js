const fs = require('fs');
const path = require('path');

// 分析日志文件的函数
async function analyzeLogFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const logData = {
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
        
        const activeSessions = {};
        const connToSessionMap = {};
        
        const lines = content.split('\n');
        for (const line of lines) {
            // 检测连接建立 (CID)
            const connMatch = line.match(/连接 "(CID-\d+)" 已建立/);
            if (connMatch) {
                const connId = connMatch[1];
                const ipMatch = line.match(/IP 地址[：:]\s*(\d+\.\d+\.\d+\.\d+)/);
                const ip = ipMatch ? ipMatch[1] : '未知IP';
                const timestamp = line.substring(0, 19);
                connToSessionMap[connId] = { ip, startTime: timestamp };
                continue;
            }
            
            // 检测会话创建 (SID)
            const sessionCreateMatch = line.match(/连接 "(CID-\d+)": 已创建新会话 "(SID-[^"]+)"/);
            if (sessionCreateMatch) {
                const connId = sessionCreateMatch[1];
                const sessionId = sessionCreateMatch[2];
                const connInfo = connToSessionMap[connId];
                if (connInfo) {
                    // 提取协议信息
                    const protoMatch = line.match(/物理底层协议："([^"]+)"/);
                    let vpnProtocol = protoMatch ? protoMatch[1] : '未知协议';
                    
                    // 简化VPN协议名称
                    if (vpnProtocol.includes('OPENVPN')) {
                        vpnProtocol = 'OpenVPN';
                    } else if (vpnProtocol.includes('L2TP')) {
                        vpnProtocol = 'L2TP';
                    }
                    
                    // 创建会话记录
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
                    
                    // 统计时段
                    const hour = parseInt(connInfo.startTime.substring(11, 13));
                    logData.timeStats[hour]++;
                    
                    // 初始化IP统计
                    if (!logData.ipStats[connInfo.ip]) {
                        logData.ipStats[connInfo.ip] = { connections: 0, totalDuration: 0, totalData: 0, vpnProtocols: {}, sessions: [] };
                    }
                    
                    // 统计协议
                    logData.vpnProtocolStats[vpnProtocol] = (logData.vpnProtocolStats[vpnProtocol] || 0) + 1;
                    logData.ipStats[connInfo.ip].vpnProtocols[vpnProtocol] = (logData.ipStats[connInfo.ip].vpnProtocols[vpnProtocol] || 0) + 1;
                    
                    // 清理连接映射
                    delete connToSessionMap[connId];
                }
                continue;
            }
            
            // 检测会话结束
            const endMatch = line.match(/会话 "(SID-[^"]+)": 会话已结束。统计信息如下: 总输出数据大小: (\d+) 字节，总输入数据大小: (\d+) 字节/);
            if (endMatch) {
                const sessionId = endMatch[1];
                const output = parseInt(endMatch[2]);
                const input = parseInt(endMatch[3]);
                
                const session = activeSessions[sessionId];
                if (session) {
                    session.endTime = line.substring(0, 19);
                    const startDate = new Date(session.startTime.replace(' ', 'T') + 'Z');
                    const endDate = new Date(session.endTime.replace(' ', 'T') + 'Z');
                    session.duration = (endDate - startDate) / (1000 * 60);
                    session.inputData = input;
                    session.outputData = output;
                    
                    // 更新IP统计
                    const stats = logData.ipStats[session.ip];
                    if (stats) {
                        stats.connections++;
                        stats.totalDuration += session.duration;
                        stats.totalData += input + output;
                        stats.sessions.push({ ...session });
                    }
                    
                    // 每日统计
                    const date = session.startTime.substring(0, 10);
                    if (!logData.dailyStats[date]) {
                        logData.dailyStats[date] = { connections: 0, totalDuration: 0, totalData: 0 };
                    }
                    logData.dailyStats[date].connections++;
                    logData.dailyStats[date].totalDuration += session.duration;
                    logData.dailyStats[date].totalData += input + output;
                    
                    // 清理会话
                    delete activeSessions[sessionId];
                }
            }
        }
        
        // 计算唯一IP数量和平均连接时长
        logData.uniqueIps = Object.keys(logData.ipStats).length;
        let totalConn = 0, totalDur = 0;
        for (const ipStat of Object.values(logData.ipStats)) {
            totalConn += ipStat.connections;
            totalDur += ipStat.totalDuration;
        }
        logData.connections = totalConn;
        logData.totalDuration = totalDur;
        logData.avgDuration = totalConn ? totalDur / totalConn : 0;
        
        // 计算总数据
        for (const ipStat of Object.values(logData.ipStats)) {
            logData.totalData += ipStat.totalData;
        }
        
        return logData;
    } catch (error) {
        console.error(`分析文件 ${filePath} 失败:`, error);
        return null;
    }
}

// 检测存在的月份
function detectExistingMonths() {
    const existing = new Set();
    const possibleYears = ['25', '26']; // 根据现有目录结构
    
    for (let y of possibleYears) {
        for (let m = 1; m <= 12; m++) {
            const mm = m.toString().padStart(2, '0');
            const folderPath = path.join(__dirname, `${y}${mm}`);
            
            if (fs.existsSync(folderPath)) {
                existing.add(`${y}${mm}`);
            }
        }
    }
    
    return Array.from(existing);
}

// 生成指定月份的所有日期文件
function getFilesInMonth(monthFolder) {
    const files = [];
    const folderPath = path.join(__dirname, monthFolder);
    
    if (fs.existsSync(folderPath)) {
        const year = monthFolder.slice(0, 2);
        const month = monthFolder.slice(2);
        const days = new Date(parseInt(year) + 2000, parseInt(month), 0).getDate();
        
        for (let d = 1; d <= days; d++) {
            const dd = d.toString().padStart(2, '0');
            const fileName = `vpn_20${year}${month}${dd}.log`;
            const filePath = path.join(folderPath, fileName);
            
            if (fs.existsSync(filePath)) {
                files.push(filePath);
            }
        }
    }
    
    return files;
}

// 分析单月日志
async function analyzeSingleMonth(month) {
    console.log(`分析单月: ${month}`);
    const files = getFilesInMonth(month);
    
    if (files.length === 0) {
        console.log(`没有找到 ${month} 月份的日志文件`);
        return null;
    }
    
    let monthLogData = {
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
    
    for (const file of files) {
        const fileLogData = await analyzeLogFile(file);
        if (fileLogData) {
            // 合并结果
            monthLogData.connections += fileLogData.connections;
            monthLogData.totalData += fileLogData.totalData;
            monthLogData.totalDuration += fileLogData.totalDuration;
            
            // 合并IP统计
            for (const [ip, stats] of Object.entries(fileLogData.ipStats)) {
                if (!monthLogData.ipStats[ip]) {
                    monthLogData.ipStats[ip] = { 
                        connections: stats.connections, 
                        totalDuration: stats.totalDuration, 
                        totalData: stats.totalData, 
                        vpnProtocols: { ...stats.vpnProtocols },
                        sessions: [...stats.sessions]
                    };
                } else {
                    monthLogData.ipStats[ip].connections += stats.connections;
                    monthLogData.ipStats[ip].totalDuration += stats.totalDuration;
                    monthLogData.ipStats[ip].totalData += stats.totalData;
                    monthLogData.ipStats[ip].sessions.push(...stats.sessions);
                    
                    // 合并VPN协议统计
                    for (const [proto, count] of Object.entries(stats.vpnProtocols)) {
                        monthLogData.ipStats[ip].vpnProtocols[proto] = (monthLogData.ipStats[ip].vpnProtocols[proto] || 0) + count;
                    }
                }
            }
            
            // 合并VPN协议统计
            for (const [proto, count] of Object.entries(fileLogData.vpnProtocolStats)) {
                monthLogData.vpnProtocolStats[proto] = (monthLogData.vpnProtocolStats[proto] || 0) + count;
            }
            
            // 合并时间统计
            for (let h = 0; h < 24; h++) {
                monthLogData.timeStats[h] += fileLogData.timeStats[h];
            }
            
            // 合并每日统计
            for (const [date, daily] of Object.entries(fileLogData.dailyStats)) {
                if (!monthLogData.dailyStats[date]) {
                    monthLogData.dailyStats[date] = { connections: daily.connections, totalDuration: daily.totalDuration, totalData: daily.totalData };
                } else {
                    monthLogData.dailyStats[date].connections += daily.connections;
                    monthLogData.dailyStats[date].totalDuration += daily.totalDuration;
                    monthLogData.dailyStats[date].totalData += daily.totalData;
                }
            }
        }
    }
    
    // 计算唯一IP数量和平均连接时长
    monthLogData.uniqueIps = Object.keys(monthLogData.ipStats).length;
    monthLogData.avgDuration = monthLogData.connections ? monthLogData.totalDuration / monthLogData.connections : 0;
    
    return monthLogData;
}

// 分析单年日志
async function analyzeSingleYear(year) {
    console.log(`分析单年: 20${year}`);
    const existingMonths = detectExistingMonths();
    const yearMonths = existingMonths.filter(month => month.startsWith(year));
    
    if (yearMonths.length === 0) {
        console.log(`没有找到 ${year} 年份的日志文件`);
        return null;
    }
    
    let yearLogData = {
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
    
    for (const month of yearMonths) {
        const monthLogData = await analyzeSingleMonth(month);
        if (monthLogData) {
            // 合并结果
            yearLogData.connections += monthLogData.connections;
            yearLogData.totalData += monthLogData.totalData;
            yearLogData.totalDuration += monthLogData.totalDuration;
            
            // 合并IP统计
            for (const [ip, stats] of Object.entries(monthLogData.ipStats)) {
                if (!yearLogData.ipStats[ip]) {
                    yearLogData.ipStats[ip] = { 
                        connections: stats.connections, 
                        totalDuration: stats.totalDuration, 
                        totalData: stats.totalData, 
                        vpnProtocols: { ...stats.vpnProtocols },
                        sessions: [...stats.sessions]
                    };
                } else {
                    yearLogData.ipStats[ip].connections += stats.connections;
                    yearLogData.ipStats[ip].totalDuration += stats.totalDuration;
                    yearLogData.ipStats[ip].totalData += stats.totalData;
                    yearLogData.ipStats[ip].sessions.push(...stats.sessions);
                    
                    // 合并VPN协议统计
                    for (const [proto, count] of Object.entries(stats.vpnProtocols)) {
                        yearLogData.ipStats[ip].vpnProtocols[proto] = (yearLogData.ipStats[ip].vpnProtocols[proto] || 0) + count;
                    }
                }
            }
            
            // 合并VPN协议统计
            for (const [proto, count] of Object.entries(monthLogData.vpnProtocolStats)) {
                yearLogData.vpnProtocolStats[proto] = (yearLogData.vpnProtocolStats[proto] || 0) + count;
            }
            
            // 合并时间统计
            for (let h = 0; h < 24; h++) {
                yearLogData.timeStats[h] += monthLogData.timeStats[h];
            }
            
            // 合并每日统计
            for (const [date, daily] of Object.entries(monthLogData.dailyStats)) {
                if (!yearLogData.dailyStats[date]) {
                    yearLogData.dailyStats[date] = { connections: daily.connections, totalDuration: daily.totalDuration, totalData: daily.totalData };
                } else {
                    yearLogData.dailyStats[date].connections += daily.connections;
                    yearLogData.dailyStats[date].totalDuration += daily.totalDuration;
                    yearLogData.dailyStats[date].totalData += daily.totalData;
                }
            }
        }
    }
    
    // 计算唯一IP数量和平均连接时长
    yearLogData.uniqueIps = Object.keys(yearLogData.ipStats).length;
    yearLogData.avgDuration = yearLogData.connections ? yearLogData.totalDuration / yearLogData.connections : 0;
    
    return yearLogData;
}

// 分析全部日志
async function analyzeAllLogs() {
    console.log('分析全部日志');
    const existingMonths = detectExistingMonths();
    
    if (existingMonths.length === 0) {
        console.log('没有找到任何日志文件');
        return null;
    }
    
    let allLogData = {
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
    
    for (const month of existingMonths) {
        const monthLogData = await analyzeSingleMonth(month);
        if (monthLogData) {
            // 合并结果
            allLogData.connections += monthLogData.connections;
            allLogData.totalData += monthLogData.totalData;
            allLogData.totalDuration += monthLogData.totalDuration;
            
            // 合并IP统计
            for (const [ip, stats] of Object.entries(monthLogData.ipStats)) {
                if (!allLogData.ipStats[ip]) {
                    allLogData.ipStats[ip] = { 
                        connections: stats.connections, 
                        totalDuration: stats.totalDuration, 
                        totalData: stats.totalData, 
                        vpnProtocols: { ...stats.vpnProtocols },
                        sessions: [...stats.sessions]
                    };
                } else {
                    allLogData.ipStats[ip].connections += stats.connections;
                    allLogData.ipStats[ip].totalDuration += stats.totalDuration;
                    allLogData.ipStats[ip].totalData += stats.totalData;
                    allLogData.ipStats[ip].sessions.push(...stats.sessions);
                    
                    // 合并VPN协议统计
                    for (const [proto, count] of Object.entries(stats.vpnProtocols)) {
                        allLogData.ipStats[ip].vpnProtocols[proto] = (allLogData.ipStats[ip].vpnProtocols[proto] || 0) + count;
                    }
                }
            }
            
            // 合并VPN协议统计
            for (const [proto, count] of Object.entries(monthLogData.vpnProtocolStats)) {
                allLogData.vpnProtocolStats[proto] = (allLogData.vpnProtocolStats[proto] || 0) + count;
            }
            
            // 合并时间统计
            for (let h = 0; h < 24; h++) {
                allLogData.timeStats[h] += monthLogData.timeStats[h];
            }
            
            // 合并每日统计
            for (const [date, daily] of Object.entries(monthLogData.dailyStats)) {
                if (!allLogData.dailyStats[date]) {
                    allLogData.dailyStats[date] = { connections: daily.connections, totalDuration: daily.totalDuration, totalData: daily.totalData };
                } else {
                    allLogData.dailyStats[date].connections += daily.connections;
                    allLogData.dailyStats[date].totalDuration += daily.totalDuration;
                    allLogData.dailyStats[date].totalData += daily.totalData;
                }
            }
        }
    }
    
    // 计算唯一IP数量和平均连接时长
    allLogData.uniqueIps = Object.keys(allLogData.ipStats).length;
    allLogData.avgDuration = allLogData.connections ? allLogData.totalDuration / allLogData.connections : 0;
    
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
    console.log('开始生成分析文件...');
    
    // 检测存在的月份
    const existingMonths = detectExistingMonths();
    console.log(`检测到的月份: ${existingMonths.join(', ')}`);
    
    // 分析单月日志
    for (const month of existingMonths) {
        const monthData = await analyzeSingleMonth(month);
        if (monthData) {
            saveAnalysisResult(path.join(__dirname, 'analysis', `${month}.json`), monthData);
        }
    }
    
    // 分析单年日志
    const years = [...new Set(existingMonths.map(month => month.slice(0, 2)))];
    for (const year of years) {
        const yearData = await analyzeSingleYear(year);
        if (yearData) {
            saveAnalysisResult(path.join(__dirname, 'analysis', `${year}.json`), yearData);
        }
    }
    
    // 分析全部日志
    const allData = await analyzeAllLogs();
    if (allData) {
        saveAnalysisResult(path.join(__dirname, 'analysis', 'all.json'), allData);
        // 同时保存为latest.json
        saveAnalysisResult(path.join(__dirname, 'analysis', 'latest.json'), allData);
    }
    
    console.log('分析文件生成完成!');
}

// 运行主函数
main().catch(console.error);
