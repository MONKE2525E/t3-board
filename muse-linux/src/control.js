const task = new URLSearchParams(location.search).get('task') || 'Computer-use session';
const label = document.getElementById('task');
label.textContent = task;
label.title = task;
document.getElementById('stop').addEventListener('click', () => window.museLocalBrowser.stop());
