const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3234);
const contentTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

function respond(res, statusCode, message) {
    res.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(message);
}

const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return respond(res, 405, 'Method not allowed');
    }

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        return respond(res, 400, 'Bad request');
    }

    const filePath = path.resolve(root, `.${pathname}`);
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        return respond(res, 403, 'Forbidden');
    }
    if (path.extname(pathname).toLowerCase() === '.php') {
        return respond(res, 501, 'PHP is not enabled. Install PHP to run this file.');
    }

    fs.stat(filePath, (statError, initialStats) => {
        if (statError) return respond(res, 404, 'Not found');

        const resolvedPath = initialStats.isDirectory() ? path.join(filePath, 'index.html') : filePath;
        fs.stat(resolvedPath, (error, stats) => {
            if (error || !stats.isFile()) return respond(res, 404, 'Not found');

            const etag = `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;
            const headers = {
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-cache',
                'Content-Type': contentTypes[path.extname(resolvedPath).toLowerCase()] || 'application/octet-stream',
                'ETag': etag,
                'Last-Modified': stats.mtime.toUTCString(),
                'X-Content-Type-Options': 'nosniff'
            };

            if (req.headers['if-none-match'] === etag) {
                res.writeHead(304, headers);
                return res.end();
            }

            let start = 0;
            let end = stats.size - 1;
            let statusCode = 200;
            const range = req.headers.range;
            if (range && req.method === 'GET') {
                const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                if (!match || (!match[1] && !match[2])) {
                    res.setHeader('Content-Range', `bytes */${stats.size}`);
                    return respond(res, 416, 'Range not satisfiable');
                }

                if (match[1]) {
                    start = Number(match[1]);
                    end = match[2] ? Number(match[2]) : end;
                } else {
                    const suffixLength = Number(match[2]);
                    start = Math.max(stats.size - suffixLength, 0);
                }
                end = Math.min(end, stats.size - 1);
                if (start > end || start >= stats.size) {
                    res.setHeader('Content-Range', `bytes */${stats.size}`);
                    return respond(res, 416, 'Range not satisfiable');
                }
                statusCode = 206;
                headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`;
            }

            headers['Content-Length'] = Math.max(0, end - start + 1);
            res.writeHead(statusCode, headers);
            if (req.method === 'HEAD' || stats.size === 0) return res.end();

            const stream = fs.createReadStream(resolvedPath, { start, end });
            stream.on('error', () => res.destroy());
            stream.pipe(res);
        });
    });
});

server.listen(port, host, () => {
    console.log(`VPN 日志分析工具已启动: http://${host}:${port}`);
    console.log('按 Ctrl+C 停止服务');
});

server.on('error', (error) => {
    console.error(`服务器启动失败: ${error.message}`);
    process.exitCode = 1;
});