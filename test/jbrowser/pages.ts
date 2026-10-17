// Test pages served on localhost for the browser tool tests.
export const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>Jolty test home</title><body style="font:16px sans-serif">
<h1>Welcome</h1>
<p>Some intro text for the page.</p>
<nav><a href="/form">Open the form</a> | <a href="/popup-target" target="_blank">New tab link</a> | <a href="/slow">Slow page</a></nav>
<button id="count" onclick="this.textContent='Clicked '+(++window.n)">Clicked 0</button>
<script>window.n=0;console.log('home loaded');console.error('a test error')</script>
<div id="far" style="margin-top:2500px"><button onclick="document.title='far clicked'">Far button</button></div>
</body>`,
  '/form': `<!doctype html><title>Form page</title><body style="font:16px sans-serif">
<form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent=JSON.stringify(Object.fromEntries(new FormData(this)));">
<label for="name">Your name</label> <input id="name" name="name"><br>
<label>Email <input name="email" type="email" placeholder="you@example.com"></label><br>
<label>Password <input name="pw" type="password"></label><br>
<label for="sel">Color</label> <select id="sel" name="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select><br>
<label><input type="checkbox" name="agree"> I agree</label><br>
<label><input type="radio" name="size" value="s"> Small</label> <label><input type="radio" name="size" value="l"> Large</label><br>
<label>Notes <textarea name="notes"></textarea></label><br>
<div id="rich" contenteditable="true" role="textbox" aria-label="Rich editor" style="border:1px solid #888;min-height:30px"></div>
<button type="submit">Send</button>
</form><pre id="out"></pre>
<input type="file" id="file" aria-label="Upload"><div id="fileout"></div>
<script>document.getElementById('file').onchange=e=>document.getElementById('fileout').textContent=[...e.target.files].map(f=>f.name+':'+f.size).join(',')</script>
</body>`,
  '/popup-target': `<!doctype html><title>Popup target</title><h2>I am the new tab</h2>`,
  '/slow': `<!doctype html><title>Slow</title><h2 id="h">Loading...</h2><script>setTimeout(()=>{document.getElementById('h').textContent='Slow content ready'},700)</script>`,
  '/dialog': `<!doctype html><title>Dialog</title><button onclick="alert('Hello from alert');document.title='after alert'">Alert</button><button onclick="document.title=confirm('Sure?')?'yes':'no'">Confirm</button><button onclick="document.title='prompt:'+prompt('Name?','x')">Prompt</button>`,
  '/shadow': `<!doctype html><title>Shadow</title><div id="host"></div><iframe id="fr" srcdoc="<button onclick=&quot;parent.document.title='iframe click'&quot;>Inside frame</button>" style="width:300px;height:80px"></iframe>
<script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<button id=sb>Shadow button</button><input aria-label="Shadow input">';r.getElementById('sb').onclick=()=>document.title='shadow click'</script>`,
  '/dnd': `<!doctype html><title>DnD</title><style>.box{width:120px;height:60px;border:1px solid #888;margin:10px;display:inline-block}</style>
<div id="a" class="box" draggable="true" role="button" aria-label="Drag me">drag</div><div id="b" class="box" aria-label="Drop zone" role="region">zone</div>
<script>const b=document.getElementById('b');b.ondragover=e=>e.preventDefault();b.ondrop=e=>{e.preventDefault();document.title='dropped '+e.dataTransfer.getData('text/plain')};document.getElementById('a').ondragstart=e=>e.dataTransfer.setData('text/plain','payload')</script>`,
  '/covered': `<!doctype html><title>Covered</title><button onclick="document.title='clicked'">Under cover</button><div style="position:fixed;inset:0;background:rgba(0,0,0,.3)" id="shield"><button onclick="document.getElementById('shield').remove()">Close cover</button></div>`
}
