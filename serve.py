#!/usr/bin/env python3
# ponytail: http.server + один заголовок. Локальный dev-сервер без кэша, чтобы правки
# были видны сразу, без hard-reload. http.server шлёт только Last-Modified → браузер
# кэширует эвристически и подсовывает старый JS. Порт — из $PORT (по умолчанию 4173).
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


port = int(os.environ.get('PORT', 4173))
HTTPServer(('', port), NoCache).serve_forever()
