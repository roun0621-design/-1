#!/usr/bin/env python3
"""파일 다운로드 전용 서버 - 모든 파일을 강제 다운로드(attachment)로 제공"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import os, sys, urllib.parse

SERVE_DIR = os.getcwd()

class DownloadHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # URL path → 파일 경로
        url_path = urllib.parse.unquote(self.path).lstrip('/')
        file_path = os.path.join(SERVE_DIR, url_path)
        
        if not os.path.isfile(file_path):
            self.send_error(404, "File not found")
            return
        
        filename = os.path.basename(file_path)
        encoded_name = urllib.parse.quote(filename)
        file_size = os.path.getsize(file_path)
        
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded_name}")
        self.send_header("Content-Length", str(file_size))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        
        with open(file_path, 'rb') as f:
            self.wfile.write(f.read())
    
    def do_HEAD(self):
        url_path = urllib.parse.unquote(self.path).lstrip('/')
        file_path = os.path.join(SERVE_DIR, url_path)
        
        if not os.path.isfile(file_path):
            self.send_error(404, "File not found")
            return
        
        filename = os.path.basename(file_path)
        encoded_name = urllib.parse.quote(filename)
        file_size = os.path.getsize(file_path)
        
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{encoded_name}")
        self.send_header("Content-Length", str(file_size))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def log_message(self, format, *args):
        sys.stdout.write(f"{self.log_date_time_string()} - {format % args}\n")
        sys.stdout.flush()

if __name__ == '__main__':
    port = 9090
    server = HTTPServer(('0.0.0.0', port), DownloadHandler)
    print(f"Download server running on port {port} (dir: {SERVE_DIR})")
    sys.stdout.flush()
    server.serve_forever()
