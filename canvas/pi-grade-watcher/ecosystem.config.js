// pm2 alternative to canvas-grade-watcher.service:
//   pm2 start ecosystem.config.js && pm2 save && pm2 startup   (run the command it prints)
//   pm2 logs canvas-grade-watcher
module.exports = {
  apps: [{
    name: 'canvas-grade-watcher',
    script: 'canvas_grade_watcher.py',
    cwd: __dirname,
    interpreter: `${__dirname}/.venv/bin/python`,
    interpreter_args: '-u',          // unbuffered, so pm2 logs show lines immediately
    autorestart: true,
    stop_exit_codes: [0],            // exits 0 once every watch is released: don't loop-restart
    restart_delay: 30000,
  }],
};
