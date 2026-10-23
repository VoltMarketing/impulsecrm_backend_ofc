// Express 4 não captura erros de funções async: um erro de banco derrubava o
// servidor inteiro. Isto faz qualquer erro virar uma resposta 500 normal.
import Layer from 'express/lib/router/layer.js';

const original = Layer.prototype.handle_request;
Layer.prototype.handle_request = function (req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return original.call(this, req, res, next); // middleware de erro
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (e) {
    next(e);
  }
};

process.on('unhandledRejection', (e) => console.error('[erro não tratado]', e?.message || e));
