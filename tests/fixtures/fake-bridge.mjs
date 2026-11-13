// Child process used by the supervisor tests: prints, then waits for a signal.
console.log('fake bridge started');
console.log('parent=' + (process.env.LBB_PARENT_PID ?? 'none'));
if (process.env.FAKE_BRIDGE_LOCKED === '1') {
    console.error('BRIDGE_LOCKED: another instance holds the lock');
    process.exit(2);
}
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
setInterval(() => { }, 1000);
