const { spawn } = require('child_process');
const hookPath = "D:\\Def's work\\RSU Projects\\final project\\logit\\.logit\\hooks\\pre-commit";
const isWindows = true;

// Attempt 1: Just shell: true
const proc = spawn(isWindows ? `"${hookPath}"` : hookPath, [], {
    shell: true,
    stdio: 'inherit'
});
proc.on('close', code => console.log('Exited with code', code));
proc.on('error', err => console.log('Error:', err));
