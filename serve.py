#!/usr/bin/env python3
# ponytail: http.server + один заголовок. Локальный dev-сервер без кэша, чтобы правки
# были видны сразу, без hard-reload. http.server шлёт только Last-Modified → браузер
# кэширует эвристически и подсовывает старый JS. Порт — из $PORT (по умолчанию 4173).
#
# Исключение — неизменяемые вендор-библиотеки (js/vendor/*): их кэшируем надолго,
# иначе three.js (615 КБ) перекачивается на каждый reload и дым «зажигается» с задержкой.
import os
from http.server import HTTPServer, SimpleHTTPRequestHandler


class Dev(SimpleHTTPRequestHandler):
    def end_headers(self):
        if self.path.startswith('/js/vendor/'):
            self.send_header('Cache-Control', 'public, max-age=31536000, immutable')
        else:
            self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()


port = int(os.environ.get('PORT', 4173))
HTTPServer(('', port), Dev).serve_forever()
