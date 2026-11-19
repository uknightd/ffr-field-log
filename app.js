"use strict";
/* FFR Field Log
   Works in two modes:
   - Cloud: config.js holds the Supabase address and public key. Everyone signs in, jobs sync to one shared database,
     and the phone keeps a local copy so technicians can work with no signal.
   - Local: no config. Everything stays on the phone (used for the preview). */

/* ---------- constants ---------- */
const TYPES={
  sla:{label:"SLA call",short:"SLA",desc:"Covered by the client's SLA"},
  nonsla:{label:"Non-SLA (chargeable)",short:"Non-SLA",desc:"Client negligence or damage"},
  install:{label:"New install",short:"Install",desc:"New cabling or equipment"},
  maint:{label:"Maintenance / other",short:"Other",desc:"Planned work, site visit, quote"}
};
const REASONS=["Cable cut by client or contractor","Cable removed or stolen","Equipment broken or damaged","Equipment moved or unplugged","Tampering or unauthorised changes","Water, fire or building damage","Power fault on client side","User error / no fault found","Work outside SLA scope","After-hours request"];
const STAGES={before:"Before",during:"During",after:"After"};
const R=n=>"R "+(Math.round((+n||0)*100)/100).toLocaleString("en-ZA",{minimumFractionDigits:2,maximumFractionDigits:2});
const uuid=()=>(crypto.randomUUID?crypto.randomUUID():"10000000-1000-4000-8000-100000000000".replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)));
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const today=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")};
const nowTime=()=>{const d=new Date();return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")};
const fmtDate=s=>{if(!s)return"";const d=new Date(s+"T00:00:00");return d.toLocaleDateString("en-ZA",{day:"numeric",month:"short",year:"numeric"})};
const hoursBetween=(a,b)=>{if(!a||!b)return 0;const[ah,am]=a.split(":").map(Number),[bh,bm]=b.split(":").map(Number);let m=(bh*60+bm)-(ah*60+am);if(m<0)m+=1440;return Math.round(m/60*100)/100};
const isTempNo=n=>!n||n.startsWith("NEW-");

/* ---------- cloud connection ---------- */
const CFG=window.FFR_CONFIG||{};
const CLOUD=!!(CFG.supabaseUrl&&CFG.supabaseKey&&window.supabase);
const sb=CLOUD?window.supabase.createClient(CFG.supabaseUrl,CFG.supabaseKey,{auth:{persistSession:true,autoRefreshToken:true,storageKey:"ffr-auth"}}):null;

/* ---------- storage on the phone (IndexedDB, memory fallback) ---------- */
const Store=(()=>{
  let db=null;const mem={jobs:new Map(),clients:new Map(),meta:new Map()};
  const open=()=>new Promise(res=>{
    try{const rq=indexedDB.open("ffr-field-log",1);
      rq.onupgradeneeded=()=>{const d=rq.result;["jobs","clients"].forEach(s=>d.objectStoreNames.contains(s)||d.createObjectStore(s,{keyPath:"id"}));d.objectStoreNames.contains("meta")||d.createObjectStore("meta",{keyPath:"key"})};
      rq.onsuccess=()=>{db=rq.result;res(true)};rq.onerror=()=>res(false);rq.onblocked=()=>res(false);
    }catch(e){res(false)}
  });
  const tx=(s,mode,fn)=>new Promise((res,rej)=>{try{const t=db.transaction(s,mode);const st=t.objectStore(s);const r=fn(st);t.oncomplete=()=>res(r&&r.result);t.onerror=()=>rej(t.error)}catch(e){rej(e)}});
  return{
    ready:open(),
    get persistent(){return !!db},
    async all(s){if(!db)return[...mem[s].values()];return tx(s,"readonly",st=>st.getAll())},
    async put(s,v){if(!db){mem[s].set(v.id??v.key,v);return}return tx(s,"readwrite",st=>st.put(v))},
    async del(s,k){if(!db){mem[s].delete(k);return}return tx(s,"readwrite",st=>st.delete(k))},
    async get(s,k){if(!db)return mem[s].get(k);return tx(s,"readonly",st=>st.get(k))},
    async clear(s){if(!db){mem[s].clear();return}return tx(s,"readwrite",st=>st.clear())}
  };
})();

/* ---------- state ---------- */
const S={
  jobs:[],clients:[],team:[],materials:[],
  settings:{company:"FFR Comms",prefix:"FFR",nextNo:1,logo:null,logoW:0,logoH:0},
  me:{name:""},            // local mode: technician name on this phone
  user:null,profile:null,  // cloud mode: signed-in person
  view:"jobs",editing:null,filter:{q:"",type:"all",status:"all",mine:false},billMonth:today().slice(0,7),
  sync:{busy:false,last:null,error:null}
};
const isAdmin=()=>!CLOUD||S.profile?.role==="admin";
const myName=()=>CLOUD?(S.profile?.full_name||""):S.me.name;
const canEditJob=j=>!CLOUD||isAdmin()||j.techId===S.user?.id;

async function loadLocal(){
  await Store.ready;
  S.clients=await Store.all("clients");
  S.jobs=await Store.all("jobs");
  const me=await Store.get("meta","me");if(me)Object.assign(S.me,me.value);
  const st=await Store.get("meta","settings");if(st)Object.assign(S.settings,st.value);
  else if(me&&me.value.company){/* settings from the first preview version */Object.assign(S.settings,{company:me.value.company,prefix:me.value.prefix||"FFR",nextNo:me.value.nextNo||1,logo:me.value.logo||null,logoW:me.value.logoW,logoH:me.value.logoH})}
  const prof=await Store.get("meta","profile");if(prof)S.profile=prof.value;
  const team=await Store.get("meta","team");if(team)S.team=team.value;
  const mats=await Store.get("meta","materials");if(mats)S.materials=mats.value;
}
async function saveMe(){await Store.put("meta",{key:"me",value:S.me});renderWho()}
async function saveSettingsLocal(){await Store.put("meta",{key:"settings",value:S.settings})}
function renderWho(){
  document.getElementById("whoami").textContent=myName()?(myName()+(CLOUD&&isAdmin()?" · Office":"")):(CLOUD?"Not signed in":"Set your name under Me");
}

async function seedExamples(){
  const c=[
    {id:"c-ex1",example:true,name:"Example: Umhlanga Office Park",site:"12 Ridge Rd, Umhlanga",contact:"Thandi M. · 031 000 0000",sla:"Gold SLA · 4h response · Mon–Fri 07:00–18:00",covers:"Faults on installed structured cabling, switches and Wi-Fi APs supplied by FFR.",excludes:"Damage by client, contractors or building work; equipment moved by client; after hours.",rate:650,callout:450},
    {id:"c-ex2",example:true,name:"Example: Berea Medical Centre",site:"88 Musgrave Rd, Berea",contact:"Dr P. Naidoo",sla:"Standard SLA · next business day",covers:"Network cabling and patch panels installed by FFR.",excludes:"Cut, removed or tampered cables; user equipment.",rate:600,callout:400},
    {id:"c-ex3",example:true,name:"Example: Pinetown Logistics",site:"5 Old Main Rd, Pinetown",contact:"Warehouse manager",sla:"No SLA (ad hoc)",covers:"",excludes:"All work chargeable.",rate:700,callout:500}
  ];
  for(const x of c)await Store.put("clients",x);
  S.clients=c;
  const d=today();
  const j=[
    {id:"j-ex1",example:true,no:"EX-0001",clientId:"c-ex1",site:"Block B, 2nd floor",date:d,timeIn:"08:30",timeOut:"10:15",type:"nonsla",reasons:["Cable cut by client or contractor"],reasonNote:"Shopfitters cut 3 CAT6 runs while removing a partition wall. Cut ends found in ceiling void, see before photos.",fault:"No network at 6 desks in Block B.",findings:"Three CAT6 cables cut 1.2 m from the wall box during partition removal.",work:"Re-ran 3 × CAT6 from patch panel to new wall box, terminated and tested.",materials:[{item:"CAT6 cable (m)",qty:"45"},{item:"RJ45 keystone",qty:"6"},{item:"Wall box",qty:"1"}],photos:[],techName:"Example technician",techSig:"",clientName:"Thandi M.",clientSig:"",ack:true,status:"done",invoiced:false,created:Date.now()-3600e3},
    {id:"j-ex2",example:true,no:"EX-0002",clientId:"c-ex2",site:"Reception",date:d,timeIn:"11:00",timeOut:"11:40",type:"sla",reasons:[],reasonNote:"",fault:"Reception PC dropping network.",findings:"Faulty patch lead at patch panel port 14.",work:"Replaced patch lead, tested link.",materials:[{item:"Patch lead 1 m",qty:"1"}],photos:[],techName:"Example technician",techSig:"",clientName:"",clientSig:"",ack:false,status:"done",invoiced:false,created:Date.now()-1800e3}
  ];
  for(const x of j)await Store.put("jobs",x);
  S.jobs=j;
  S.materials=[
    {id:"m-ex1",example:true,name:"CAT6 cable",unit:"m",price:14.5},
    {id:"m-ex2",example:true,name:"RJ45 keystone jack",unit:"each",price:38},
    {id:"m-ex3",example:true,name:"Wall box (single)",unit:"each",price:65},
    {id:"m-ex4",example:true,name:"Patch lead 1 m",unit:"each",price:45},
    {id:"m-ex5",example:true,name:"Fibre patch lead LC-LC 2 m",unit:"each",price:180}
  ];await saveMaterialsLocal();
  for(const x of j)for(const m of x.materials){const pm=S.materials.find(p=>m.item.toLowerCase().startsWith(p.name.toLowerCase().slice(0,8)));if(pm){m.materialId=pm.id;m.unit=pm.unit;m.price=pm.price}}
  for(const x of j)await Store.put("jobs",x);
}
async function saveMaterialsLocal(){await Store.put("meta",{key:"materials",value:S.materials})}

/* ---------- mapping between the phone and the database ---------- */
const jobToRow=j=>({id:j.id,no:isTempNo(j.no)?null:j.no,client_id:j.clientId||null,site:j.site,date:j.date,time_in:j.timeIn,time_out:j.timeOut,type:j.type,reasons:j.reasons,reason_note:j.reasonNote,fault:j.fault,findings:j.findings,work:j.work,materials:j.materials,tech_id:j.techId,tech_name:j.techName,tech_sig:j.techSig,client_name:j.clientName,client_sig:j.clientSig,ack:j.ack,status:j.status,invoiced:j.invoiced,signed_at:j.signedAt?new Date(j.signedAt).toISOString():null,updated_at:new Date().toISOString()});
const rowToJob=(r,photos)=>({id:r.id,no:r.no,clientId:r.client_id||"",site:r.site||"",date:r.date,timeIn:r.time_in||"",timeOut:r.time_out||"",type:r.type||"",reasons:r.reasons||[],reasonNote:r.reason_note||"",fault:r.fault||"",findings:r.findings||"",work:r.work||"",materials:r.materials||[],techId:r.tech_id,techName:r.tech_name||"",techSig:r.tech_sig||"",clientName:r.client_name||"",clientSig:r.client_sig||"",ack:!!r.ack,status:r.status,invoiced:!!r.invoiced,signedAt:r.signed_at?Date.parse(r.signed_at):null,created:Date.parse(r.created_at),photos,dirty:false});
const rowToPhoto=r=>({id:r.id,stage:r.stage,ts:Date.parse(r.taken_at),lat:r.lat,lng:r.lng,acc:r.acc,path:r.path,w:r.w,h:r.h,uploaded:true,data:null});
const clientToRow=c=>({id:c.id,name:c.name,site:c.site,contact:c.contact,sla:c.sla,covers:c.covers,excludes:c.excludes,rate:+c.rate||0,callout:+c.callout||0,updated_at:new Date().toISOString()});

/* ---------- sync ---------- */
function setNet(){
  const el=document.getElementById("netstate");if(!el)return;
  el.hidden=CLOUD&&!S.user;
  if(!CLOUD){el.textContent=Store.persistent?"Saved on this device":"Not saved (private mode)";el.className="pill draft";return}
  const waiting=S.jobs.filter(j=>j.dirty).length;
  if(S.sync.busy){el.textContent="Syncing…";el.className="pill draft"}
  else if(!navigator.onLine){el.textContent=waiting?`Offline · ${waiting} to send`:"Offline";el.className="pill nonsla"}
  else if(waiting){el.textContent=`${waiting} waiting to send`;el.className="pill nonsla"}
  else{el.textContent="All synced";el.className="pill done"}
}
let syncAgain=false;
async function syncNow(){
  if(!CLOUD||!S.user||!S.profile?.active)return;
  if(S.sync.busy){syncAgain=true;return}
  if(!navigator.onLine){setNet();return}
  S.sync.busy=true;setNet();
  try{
    // 1. send this phone's changes
    for(const j of S.jobs.filter(j=>j.dirty)){
      try{
        if(isTempNo(j.no)){const{data,error}=await sb.rpc("next_job_no");if(error)throw error;j.no=data}
        if(!j.techId)j.techId=S.user.id;
        const{error}=await sb.from("jobs").upsert(jobToRow(j));if(error)throw error;
        for(const p of j.photos.filter(p=>!p.uploaded)){
          const path=`${j.id}/${p.id}.jpg`;
          const blob=await (await fetch(p.data)).blob();
          const up=await sb.storage.from("job-photos").upload(path,blob,{contentType:"image/jpeg",upsert:true});
          if(up.error&&!/exist/i.test(up.error.message))throw up.error;
          const r=await sb.from("photos").upsert({id:p.id,job_id:j.id,stage:p.stage,taken_at:new Date(p.ts).toISOString(),lat:p.lat,lng:p.lng,acc:p.acc,path,w:p.w,h:p.h});
          if(r.error)throw r.error;
          p.uploaded=true;p.path=path;
        }
        if(j.removedPhotos?.length){
          await sb.from("photos").delete().in("id",j.removedPhotos.map(x=>x.id));
          const paths=j.removedPhotos.map(x=>x.path).filter(Boolean);if(paths.length)await sb.storage.from("job-photos").remove(paths);
          j.removedPhotos=[];
        }
        j.dirty=false;j.syncError=null;
      }catch(e){j.syncError=e.message||String(e);console.warn("sync job",j.no,e)}
      await Store.put("jobs",j);
    }
    // 2. fetch everyone's latest
    const[cl,st,jb,ph,pr]=await Promise.all([
      sb.from("clients").select("*"),
      sb.from("settings").select("*").eq("id",1).maybeSingle(),
      sb.from("jobs").select("*").order("date",{ascending:false}).limit(2000),
      sb.from("photos").select("*").limit(20000),
      sb.from("profiles").select("*")
    ]);
    for(const r of[cl,st,jb,ph,pr])if(r.error)throw r.error;
    S.clients=cl.data.map(c=>({...c,rate:+c.rate,callout:+c.callout}));
    await Store.clear("clients");for(const c of S.clients)await Store.put("clients",c);
    if(st.data){Object.assign(S.settings,{company:st.data.company,prefix:st.data.prefix,nextNo:st.data.next_no,logo:st.data.logo,logoW:st.data.logo_w,logoH:st.data.logo_h});await saveSettingsLocal()}
    S.team=pr.data;await Store.put("meta",{key:"team",value:S.team});
    await syncMaterials();
    const mt=await sb.from("materials").select("*").order("name");
    if(!mt.error){const local=S.materials.filter(m=>m.unsynced&&!mt.data.some(r=>r.id===m.id));
      S.materials=mt.data.map(m=>({id:m.id,name:m.name,unit:m.unit,price:+m.price,active:m.active,needsPrice:!!m.needs_price,addedBy:(S.team.find(p=>p.id===m.added_by)||{}).full_name||""})).filter(m=>m.active!==false).concat(local);
      await saveMaterialsLocal();
      if(await applyPrices()){syncAgain=true}}
    const me=pr.data.find(p=>p.id===S.user.id);if(me){S.profile=me;await Store.put("meta",{key:"profile",value:me})}
    const byJob={};for(const p of ph.data)(byJob[p.job_id]=byJob[p.job_id]||[]).push(rowToPhoto(p));
    const local=new Map(S.jobs.map(j=>[j.id,j]));const seen=new Set();
    for(const r of jb.data){
      seen.add(r.id);const l=local.get(r.id);
      if(l&&l.dirty)continue;
      const photos=(byJob[r.id]||[]).sort((a,b)=>a.ts-b.ts);
      if(l)for(const p of photos){const lp=l.photos.find(x=>x.id===p.id);if(lp&&lp.data)p.data=lp.data}
      const j=rowToJob(r,photos);local.set(j.id,j);await Store.put("jobs",j);
    }
    for(const[id,j]of local)if(!seen.has(id)&&!j.dirty){local.delete(id);await Store.del("jobs",id)}
    S.jobs=[...local.values()];
    S.sync.last=Date.now();S.sync.error=null;
  }catch(e){S.sync.error=e.message||String(e);console.warn("sync",e)}
  finally{S.sync.busy=false;setNet();renderWho();
    if(["jobs","billing","clients","settings"].includes(S.view))render();
    if(syncAgain){syncAgain=false;setTimeout(syncNow,300)}}
}
window.addEventListener("online",()=>{setNet();syncNow()});
window.addEventListener("offline",setNet);
setInterval(()=>{if(document.visibilityState==="visible")syncNow()},60000);
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")syncNow()});

/* photos stored online are fetched when needed */
const urlCache={};
async function hydratePhotos(root){
  if(!CLOUD)return;
  const imgs=[...(root||document).querySelectorAll("img[data-path]")].filter(i=>!i.getAttribute("src"));
  const need=[...new Set(imgs.map(i=>i.dataset.path))].filter(p=>!(urlCache[p]&&urlCache[p].exp>Date.now()));
  if(need.length&&navigator.onLine){const{data}=await sb.storage.from("job-photos").createSignedUrls(need,3600);(data||[]).forEach(d=>{if(d.signedUrl)urlCache[d.path]={url:d.signedUrl,exp:Date.now()+3500e3}})}
  imgs.forEach(i=>{const c=urlCache[i.dataset.path];if(c)i.src=c.url;else i.alt="Photo available when online"});
}
const photoImg=(p,alt)=>p.data?`<img src="${p.data}" alt="${esc(alt)}">`:`<img data-path="${esc(p.path)}" alt="${esc(alt)}">`;
async function photoData(p){
  if(p.data)return p.data;
  if(!CLOUD||!p.path)return null;
  const{data,error}=await sb.storage.from("job-photos").download(p.path);if(error)return null;
  return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(data)});
}

/* ---------- helpers ---------- */
const client=id=>S.clients.find(c=>c.id===id);
const view=document.getElementById("view");
function toast(msg){const t=document.createElement("div");t.className="toast";t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2800)}
function confirmBox(text,okLabel){return new Promise(res=>{const m=document.createElement("div");m.className="modal";m.innerHTML=`<div class="box" role="dialog" aria-modal="true"><div>${esc(text)}</div><div class="actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">${esc(okLabel||"OK")}</button></div></div>`;m.addEventListener("click",e=>{const a=e.target.dataset.a;if(a||e.target===m){m.remove();res(a==="yes")}});document.body.appendChild(m)})}
function go(v,arg){S.view=v;S.arg=arg;window.scrollTo(0,0);render()}
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>{if(CLOUD&&!S.profile?.active)return;const v=b.dataset.go;if(v==="new"){S.editing=newJob();go("edit")}else go(v)}));
function needOnline(){if(!CLOUD)return false;if(!navigator.onLine){toast("You're offline. Try again when you have signal.");return true}return false}

function newJob(){return{id:uuid(),no:"",clientId:"",site:"",date:today(),timeIn:nowTime(),timeOut:"",type:"",reasons:[],reasonNote:"",fault:"",findings:"",work:"",materials:[],photos:[],techId:S.user?.id||null,techName:myName(),techSig:"",clientName:"",clientSig:"",ack:false,status:"draft",invoiced:false,created:Date.now(),dirty:true}}
function jobHours(j){return hoursBetween(j.timeIn,j.timeOut)}
const lineTotal=m=>(parseFloat(String(m.qty).replace(",","."))||0)*(+m.price||0);
const matTotal=j=>j.materials.filter(m=>m.item).reduce((s,m)=>s+lineTotal(m),0);
const labour=j=>{const c=client(j.clientId)||{};return jobHours(j)*(+c.rate||0)};
function jobAmount(j){const c=client(j.clientId)||{};return (+c.callout||0)+labour(j)+matTotal(j)}
const matByName=n=>{n=String(n||"").trim().toLowerCase();return S.materials.find(m=>m.name.toLowerCase()===n)};

/* ---------- downloads (works inside Claude and as a normal web app) ---------- */
let dlCap; const dlReady=(async()=>{try{dlCap=(window.claude&&window.claude.use)?await window.claude.use("downloads"):null}catch(e){dlCap=null}})();
async function saveFile(filename,blob){
  await dlReady;
  if(dlCap){try{await dlCap.save({filename,data:blob});toast("Saved "+filename)}catch(e){if(e&&e.code!=="declined")toast("Could not save the file here")}return}
  // On phones, offer the share sheet so the report can go straight to WhatsApp or email
  try{const f=new File([blob],filename,{type:blob.type});if(navigator.canShare&&navigator.canShare({files:[f]})&&/Android|iPhone|iPad/i.test(navigator.userAgent)){await navigator.share({files:[f],title:filename});return}}catch(e){if(e&&e.name==="AbortError")return}
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},2000);
}

/* ---------- render ---------- */
function render(){
  setNet();
  const nav=document.querySelector("nav.tabs");
  if(CLOUD&&!S.user){nav.hidden=true;return vLogin()}
  if(CLOUD&&!S.profile?.active){nav.hidden=true;return vWaiting()}
  nav.hidden=false;
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-current",(b.dataset.go===S.view||(S.view==="edit"&&b.dataset.go==="new")||(S.view==="job"&&b.dataset.go==="jobs")||(["client","materials"].includes(S.view)&&b.dataset.go==="clients"))?"page":"false"));
  ({jobs:vJobs,edit:vEdit,job:vJob,billing:vBilling,clients:vClients,client:vClient,settings:vSettings,materials:vMaterials}[S.view]||vJobs)();
  hydratePhotos(view);
}

/* ---------- sign in ---------- */
function vLogin(mode){
  mode=mode||"in";
  view.innerHTML=`<h1>${mode==="in"?"Sign in":"Create your account"}</h1><p class="lead">${mode==="in"?"Use the email and password you registered with.":"After you sign up, the office approves your account before you can log jobs."}</p>
  <form class="section" id="lf">
   ${mode==="up"?`<label class="f">Your full name<input type="text" id="l-name" autocomplete="name" required></label>`:""}
   <label class="f">Email<input type="text" inputmode="email" id="l-email" autocomplete="email" required></label>
   <label class="f">Password<input type="password" id="l-pass" autocomplete="${mode==="in"?"current-password":"new-password"}" required minlength="6" style="width:100%;font:inherit;color:var(--fg);background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:10px 11px;min-height:44px"></label>
   <div class="actions"><button class="btn primary" type="submit" id="l-go">${mode==="in"?"Sign in":"Create account"}</button></div>
   <p class="note" style="margin:0" id="l-msg"></p>
  </form>
  <div class="actions" style="margin-top:12px"><button class="btn ghost" id="l-switch">${mode==="in"?"New technician? Create an account":"Already have an account? Sign in"}</button>${mode==="in"?'<button class="btn ghost" id="l-forgot">Forgot password</button>':""}</div>`;
  const $=id=>document.getElementById(id);const msg=t=>{$("l-msg").textContent=t};
  $("l-switch").onclick=()=>vLogin(mode==="in"?"up":"in");
  if($("l-forgot"))$("l-forgot").onclick=async()=>{const em=$("l-email").value.trim();if(!em){msg("Type your email above first.");return}const{error}=await sb.auth.resetPasswordForEmail(em,{redirectTo:location.origin+location.pathname});msg(error?error.message:"Check your email for a link to set a new password.")};
  $("lf").onsubmit=async e=>{e.preventDefault();if(needOnline())return;$("l-go").disabled=true;msg("");
    const email=$("l-email").value.trim(),password=$("l-pass").value;
    try{
      if(mode==="in"){const{error}=await sb.auth.signInWithPassword({email,password});if(error)throw error}
      else{const{data,error}=await sb.auth.signUp({email,password,options:{data:{full_name:$("l-name").value.trim()},emailRedirectTo:location.origin+location.pathname}});if(error)throw error;
        if(!data.session){msg("Check your email and tap the link to confirm your account, then sign in here.");$("l-go").disabled=false;return}}
    }catch(err){msg(/invalid login/i.test(err.message)?"That email and password don't match.":err.message);$("l-go").disabled=false}
  };
}
function vWaiting(){
  view.innerHTML=`<h1>Waiting for approval</h1><p class="lead">Hi ${esc(S.profile?.full_name||"")}. Your account is set up. The office needs to approve it before you can log jobs.</p>
  <div class="actions"><button class="btn primary" id="w-r">Check again</button><button class="btn" id="w-out">Sign out</button></div>`;
  document.getElementById("w-r").onclick=async()=>{await refreshProfile();render()};
  document.getElementById("w-out").onclick=signOut;
}
async function refreshProfile(){
  if(!S.user||!navigator.onLine)return;
  const{data}=await sb.from("profiles").select("*").eq("id",S.user.id).maybeSingle();
  if(data){S.profile=data;await Store.put("meta",{key:"profile",value:data})}
}
async function signOut(){
  const waiting=S.jobs.filter(j=>j.dirty).length;
  if(waiting&&!await confirmBox(`${waiting} job(s) on this phone haven't been sent yet and will be lost if you sign out. Sign out anyway?`,"Sign out"))return;
  await sb.auth.signOut();for(const s of["jobs","clients","meta"])await Store.clear(s);
  S.jobs=[];S.clients=[];S.team=[];S.user=null;S.profile=null;go("jobs");
}

/* ---------- jobs list ---------- */
function vJobs(){
  const f=S.filter;const q=f.q.toLowerCase();
  const list=S.jobs.filter(j=>(f.type==="all"||j.type===f.type)&&(f.status==="all"||j.status===f.status)&&(!f.mine||j.techId===S.user?.id)&&(!q||[j.no,client(j.clientId)?.name,j.site,j.fault,j.work,j.techName].join(" ").toLowerCase().includes(q))).sort((a,b)=>(b.date+b.timeIn).localeCompare(a.date+a.timeIn)||b.created-a.created);
  const mo=today().slice(0,7);const mj=S.jobs.filter(j=>j.date.startsWith(mo));
  const non=mj.filter(j=>j.type==="nonsla");
  view.innerHTML=`<h1>Jobs</h1><p class="lead">Every call-out, install and site visit, logged with photos and sign-off.</p>
  ${isAdmin()&&needsPriceList().length?`<button class="callout" id="go-np" style="display:block;width:100%;text-align:left;margin-bottom:12px;border-top:0;border-right:0;border-bottom:0;color:var(--fg);font:inherit;cursor:pointer"><b>${needsPriceList().length} material${needsPriceList().length>1?"s need":" needs"} a price.</b> Technicians added ${needsPriceList().length>1?"them":"it"} on site. Tap to set prices.</button>`:""}
  ${S.sync.error&&navigator.onLine?`<div class="callout" style="margin-bottom:12px">Couldn't sync just now: ${esc(S.sync.error)}</div>`:""}
  <div class="stats"><div class="stat"><b>${mj.length}</b><span>Jobs this month</span></div><div class="stat non"><b>${non.length}</b><span>Non-SLA this month</span></div><div class="stat"><b>${non.filter(j=>!j.invoiced).length}</b><span>Not yet billed</span></div></div>
  <div class="toolbar"><input type="search" id="q" placeholder="Search job no, client, site…" value="${esc(f.q)}" aria-label="Search jobs">
  <select id="ft" aria-label="Job type"><option value="all">All types</option>${Object.entries(TYPES).map(([k,t])=>`<option value="${k}" ${f.type===k?"selected":""}>${t.short}</option>`).join("")}</select>
  <select id="fs" aria-label="Status"><option value="all">Any status</option><option value="draft" ${f.status==="draft"?"selected":""}>In progress</option><option value="done" ${f.status==="done"?"selected":""}>Signed off</option></select>
  ${CLOUD?`<label class="chip"><input type="checkbox" id="fm" ${f.mine?"checked":""} style="accent-color:var(--accent)">My jobs</label>`:""}</div>
  <div class="jobs">${list.length?list.map(jobCard).join(""):`<div class="empty">No jobs match. Tap <b>New job</b> to log one.</div>`}</div>`;
  const q1=document.getElementById("q");q1.addEventListener("input",()=>{f.q=q1.value;const p=q1.selectionStart;vJobs();const n=document.getElementById("q");n.focus();n.setSelectionRange(p,p)});
  document.getElementById("ft").onchange=e=>{f.type=e.target.value;vJobs()};
  document.getElementById("fs").onchange=e=>{f.status=e.target.value;vJobs()};
  const fm=document.getElementById("fm");if(fm)fm.onchange=e=>{f.mine=e.target.checked;vJobs()};
  view.querySelectorAll(".job").forEach(el=>el.onclick=()=>go("job",el.dataset.id));
  const np=document.getElementById("go-np");if(np)np.onclick=()=>go("materials");
}
function typePill(t){return t?`<span class="pill ${t}">${TYPES[t].short}</span>`:`<span class="pill draft">Type not set</span>`}
function jobCard(j){const c=client(j.clientId);return`<button class="job" data-id="${j.id}" data-t="${j.type}"><span class="stripe"></span><span class="body">
  <span class="l1"><span class="no">${esc(isTempNo(j.no)?"New job":j.no)}</span>${typePill(j.type)}<span class="pill ${j.status==="done"?"done":"draft"}">${j.status==="done"?"Signed off":"In progress"}</span>${j.example?'<span class="pill ex">Example</span>':""}${CLOUD&&j.dirty?'<span class="pill nonsla">Not sent</span>':""}</span>
  <span class="client">${esc(c?c.name:"No client selected")}</span>
  <span class="meta">${fmtDate(j.date)} · ${esc(j.timeIn)}${j.timeOut?"–"+esc(j.timeOut):""}${CLOUD&&j.techName?" · "+esc(j.techName):""} · ${j.photos.length} photo${j.photos.length===1?"":"s"}${j.type==="nonsla"&&j.reasons.length?" · "+esc(j.reasons[0]):""}</span></span></button>`}

/* ---------- edit job ---------- */
function vEdit(){
  const j=S.editing;const c=client(j.clientId);const known=S.jobs.some(x=>x.id===j.id);
  view.innerHTML=`<h1>${isTempNo(j.no)?"New job":esc(j.no)}</h1><p class="lead">Fill in as you work. Everything saves on this phone as you go, even with no signal${CLOUD?", and sends to the office when you're back online":""}.</p>
  <div class="stack">
  <section class="section"><h2>Client and site</h2>
    <label class="f">Client<select id="e-client"><option value="">Choose client…</option>${S.clients.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(x=>`<option value="${x.id}" ${x.id===j.clientId?"selected":""}>${esc(x.name)}</option>`).join("")}${isAdmin()?'<option value="__new">+ Add a new client</option>':""}</select></label>
    ${!S.clients.length?`<p class="note" style="margin:0">${isAdmin()?"No clients yet. Choose “Add a new client”.":"No clients yet. Ask the office to add your clients."}</p>`:""}
    ${c?`<div class="callout info"><b>${esc(c.sla||"No SLA on file")}</b>${c.covers?"<br>Covers: "+esc(c.covers):""}${c.excludes?"<br>Not covered: "+esc(c.excludes):""}</div>`:""}
    <label class="f">Site / area<input type="text" id="e-site" value="${esc(j.site)}" placeholder="e.g. Block B, 2nd floor server room"></label>
    <div class="row"><label class="f">Date<input type="date" id="e-date" value="${esc(j.date)}"></label><label class="f">Arrived<input type="time" id="e-in" value="${esc(j.timeIn)}"></label><label class="f">Left<input type="time" id="e-out" value="${esc(j.timeOut)}"></label></div>
  </section>
  <section class="section"><h2>Type of job</h2>
    <div class="seg" role="group" aria-label="Type of job">${Object.entries(TYPES).map(([k,t])=>`<button type="button" data-v="${k}" aria-pressed="${j.type===k}"><b>${t.label}</b><span>${t.desc}</span></button>`).join("")}</div>
    <div id="nonsla-box" ${j.type==="nonsla"?"":"hidden"} class="stack">
      <div class="callout">This job will be marked <b>chargeable</b>. Pick what caused the fault and take clear <b>before</b> photos of the damage.</div>
      <div class="chips">${REASONS.map((r,i)=>`<label class="chip"><input type="checkbox" data-r="${i}" ${j.reasons.includes(r)?"checked":""}>${esc(r)}</label>`).join("")}</div>
      <label class="f">What happened? (evidence for the client)<textarea id="e-rnote" placeholder="e.g. Builders cut 3 cables while removing a wall. Cut ends found in ceiling.">${esc(j.reasonNote)}</textarea></label>
    </div>
  </section>
  <section class="section"><h2>The work</h2>
    <label class="f">Fault reported / job requested<textarea id="e-fault">${esc(j.fault)}</textarea></label>
    <label class="f">What you found<textarea id="e-find">${esc(j.findings)}</textarea></label>
    <label class="f">Work done<textarea id="e-work">${esc(j.work)}</textarea></label>
  </section>
  <section class="section"><h2>Materials used</h2><p class="note" style="margin:0">Start typing to pick from the office price list.${S.materials.length?"":" The price list is empty, so ask the office to add materials."}</p><datalist id="matlist">${S.materials.map(m=>`<option value="${esc(m.name)}">${esc(m.unit)} · ${R(m.price)}</option>`).join("")}</datalist><div id="mats" class="stack" style="gap:6px"></div><div><button class="btn small" id="add-mat" type="button">+ Add material</button></div></section>
  <section class="section"><h2>Photos</h2>
    <p class="note" style="margin:0">Each photo is stamped with the client, date, time and GPS location.</p>
    <div class="addph">${Object.entries(STAGES).map(([k,l])=>`<label class="btn file-btn">${l} photo<input type="file" accept="image/*" capture="environment" data-stage="${k}" multiple></label>`).join("")}</div>
    <div class="photos" id="photos"></div>
  </section>
  <section class="section"><h2>Sign-off</h2>
    <label class="f">Technician name<input type="text" id="e-tech" value="${esc(j.techName)}"></label>
    ${sigBlock("tech","Technician signature",j.techSig)}
    <label class="f">Client representative name<input type="text" id="e-cname" value="${esc(j.clientName)}"></label>
    <label class="chip" id="ack-wrap" ${j.type==="nonsla"?"":"hidden"} style="border-radius:8px;align-items:flex-start;padding:10px 12px"><input type="checkbox" id="e-ack" ${j.ack?"checked":""} style="margin-top:3px"><span>Client agrees the fault was not covered by the SLA and that this work is chargeable.</span></label>
    ${sigBlock("client","Client signature",j.clientSig)}
  </section>
  <div class="actions"><button class="btn" id="save-draft">Save, finish later</button><button class="btn primary" id="finish">Sign off job</button></div>
  ${known&&(isAdmin()||j.status==="draft")?`<div class="actions"><button class="btn danger" id="del">Delete job</button></div>`:""}
  </div>`;
  const $=id=>document.getElementById(id);
  const bind=(id,key)=>$(id).addEventListener("input",e=>{j[key]=e.target.value;autosave()});
  [["e-site","site"],["e-date","date"],["e-in","timeIn"],["e-out","timeOut"],["e-rnote","reasonNote"],["e-fault","fault"],["e-find","findings"],["e-work","work"],["e-tech","techName"],["e-cname","clientName"]].forEach(a=>bind(...a));
  $("e-client").onchange=e=>{if(e.target.value==="__new"){S.returnToEdit=true;go("client","new");return}j.clientId=e.target.value;autosave();vEdit()};
  view.querySelectorAll(".seg button").forEach(b=>b.onclick=()=>{j.type=b.dataset.v;autosave();view.querySelectorAll(".seg button").forEach(x=>x.setAttribute("aria-pressed",x===b));$("nonsla-box").hidden=j.type!=="nonsla";$("ack-wrap").hidden=j.type!=="nonsla"});
  view.querySelectorAll("[data-r]").forEach(cb=>cb.onchange=()=>{j.reasons=[...view.querySelectorAll("[data-r]:checked")].map(x=>REASONS[+x.dataset.r]);autosave()});
  $("e-ack").onchange=e=>{j.ack=e.target.checked;autosave()};
  renderMats();$("add-mat").onclick=()=>{j.materials.push({item:"",qty:"1",price:0});renderMats();const ins=$("mats").querySelectorAll("input[data-k=item]");ins[ins.length-1]?.focus()};
  renderPhotos();
  view.querySelectorAll("input[type=file]").forEach(inp=>inp.onchange=async()=>{const files=[...inp.files];inp.value="";for(const f of files){await addPhoto(f,inp.dataset.stage)}});
  initSig("tech",v=>{j.techSig=v;autosave()});initSig("client",v=>{j.clientSig=v;autosave()});
  $("save-draft").onclick=async()=>{await persist(j);syncNow();toast("Saved. You can finish it later.");go("jobs")};
  $("finish").onclick=finish;
  if($("del"))$("del").onclick=deleteJob;
  if(!S.me.name&&!CLOUD&&!j.techName)toast("Tip: set your name under Me so it fills in automatically");
}
async function deleteJob(){
  const j=S.editing;
  if(!await confirmBox("Delete this job and its photos? This cannot be undone.","Delete"))return;
  if(CLOUD&&!j.dirty||CLOUD&&!isTempNo(j.no)){
    if(needOnline())return;
    const paths=j.photos.map(p=>p.path).filter(Boolean);
    const{error}=await sb.from("jobs").delete().eq("id",j.id);if(error){toast("Couldn't delete: "+error.message);return}
    if(paths.length)await sb.storage.from("job-photos").remove(paths);
  }
  await Store.del("jobs",j.id);S.jobs=S.jobs.filter(x=>x.id!==j.id);toast("Job deleted");go("jobs");
}
function renderMats(){const j=S.editing;const box=document.getElementById("mats");
  const row=(m,i)=>`<div class="matrow"><input type="text" list="matlist" data-mi="${i}" data-k="item" value="${esc(m.item)}" placeholder="Material, e.g. CAT6 cable" aria-label="Material" autocomplete="off">
    <input type="text" inputmode="decimal" data-mi="${i}" data-k="qty" value="${esc(m.qty)}" placeholder="Qty" aria-label="Quantity">
    <button class="btn small ghost" data-rm="${i}" aria-label="Remove">✕</button>
    <div class="matinfo" data-info="${i}">${matInfo(m,i)}</div></div>`;
  box.innerHTML=j.materials.length?j.materials.map(row).join("")+`<div class="mattot">Materials total <b data-mt>${R(matTotal(j))}</b></div>`:`<p class="note" style="margin:0">No materials added.</p>`;
  const refresh=i=>{const info=box.querySelector(`[data-info="${i}"]`);if(info)info.innerHTML=matInfo(j.materials[i],i);bindInfo();const t=box.querySelector("[data-mt]");if(t)t.textContent=R(matTotal(j))};
  box.querySelectorAll("input[data-mi]").forEach(inp=>{
    inp.oninput=()=>{const i=+inp.dataset.mi,m=j.materials[i];m[inp.dataset.k]=inp.value;
      if(inp.dataset.k==="item")linkMaterial(m);
      refresh(i);autosave()};
    if(inp.dataset.k==="item")inp.onchange=async()=>{const i=+inp.dataset.mi,m=j.materials[i];
      if(m.item.trim()&&!m.materialId){await addMissingMaterial(m);refresh(i);autosave()}};
  });
  const bindInfo=()=>{
    box.querySelectorAll("[data-price]").forEach(inp=>inp.onchange=async()=>{const i=+inp.dataset.price,m=j.materials[i];const pm=S.materials.find(x=>x.id===m.materialId);const v=parseFloat(inp.value.replace(",","."))||0;if(!pm||v<=0)return;
      const old={...pm};pm.price=v;pm.needsPrice=false;if(!await saveMaterial(pm)){Object.assign(pm,old);refresh(i);return}await saveMaterialsLocal();await applyPrices();linkMaterial(m);refresh(i);autosave();toast(`${pm.name} added to the price list at ${R(v)}`)});
    box.querySelectorAll("[data-unit]").forEach(sel=>sel.onchange=async()=>{const i=+sel.dataset.unit,m=j.materials[i];const pm=S.materials.find(x=>x.id===m.materialId);if(!pm)return;pm.unit=sel.value;m.unit=sel.value;await saveMaterialsLocal();if(pm.unsynced||isAdmin())syncMaterials();autosave()});
  };
  bindInfo();
  box.querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{j.materials.splice(+b.dataset.rm,1);renderMats();autosave()});
}
const UNITS=["each","m","box","roll","pack","hour","set"];
function linkMaterial(m){const pm=matByName(m.item);
  if(pm){m.materialId=pm.id;m.unit=pm.unit;if(pm.needsPrice){m.price=0;m.pending=true}else{m.price=pm.price;delete m.pending}}
  else{delete m.materialId;delete m.pending;m.price=0;m.unit=""}}
async function addMissingMaterial(m){
  const name=m.item.trim();if(!name)return;
  const pm={id:uuid(),name,unit:"each",price:0,needsPrice:true,unsynced:true,addedBy:myName()};
  S.materials.push(pm);await saveMaterialsLocal();linkMaterial(m);
  toast(`${name} added to the materials list. The office will set the price.`);
  syncMaterials();
}
function matInfo(m,i){
  if(!m||!m.item)return"";
  const pm=m.materialId&&S.materials.find(x=>x.id===m.materialId);
  if(pm&&pm.needsPrice){
    const unitSel=`<select data-unit="${i}" aria-label="Unit" style="min-height:32px;padding:2px 6px;width:auto">${[...new Set([...UNITS,pm.unit])].map(u=>`<option ${u===pm.unit?"selected":""}>${esc(u)}</option>`).join("")}</select>`;
    if(isAdmin())return`New material, no price yet. Unit ${unitSel} Price each: <input type="text" inputmode="decimal" data-price="${i}" placeholder="0.00" aria-label="Price each" style="width:90px;min-height:32px;padding:4px 8px">`;
    return`<span class="pill nonsla" style="text-transform:none;letter-spacing:0">Waiting for office price</span> Unit ${unitSel}`;
  }
  if(m.materialId)return`${esc(m.unit||"each")} @ ${R(m.price)} = <b>${R(lineTotal(m))}</b>`;
  return`Not on the price list yet. It will be added when you move to the next box.`;
}
/* fill in prices on job lines that were waiting for the office */
async function applyPrices(){
  let n=0;
  for(const j of S.jobs){if(j.invoiced||!canEditJob(j))continue;let ch=false;
    for(const m of j.materials){if(!m.pending||!m.materialId)continue;const pm=S.materials.find(x=>x.id===m.materialId);
      if(pm&&!pm.needsPrice&&pm.price>0){m.price=pm.price;m.unit=pm.unit;delete m.pending;ch=true}}
    if(ch){n++;j.dirty=true;await Store.put("jobs",j)}}
  if(n)setNet();return n;
}
const pendingLines=j=>j.materials.filter(m=>m.item&&m.pending).length;
const needsPriceList=()=>S.materials.filter(m=>m.needsPrice);
let matSyncBusy=false;
async function syncMaterials(){
  if(!CLOUD||!S.user||!navigator.onLine||matSyncBusy)return;matSyncBusy=true;
  try{for(const pm of S.materials.filter(x=>x.unsynced)){
      const row=isAdmin()?{id:pm.id,name:pm.name,unit:pm.unit,price:pm.price,needs_price:!!pm.needsPrice}:{id:pm.id,name:pm.name,unit:pm.unit,price:0,needs_price:true};
      const{error}=isAdmin()?await sb.from("materials").upsert(row):await sb.from("materials").insert(row);
      if(error&&!/duplicate key/i.test(error.message)){console.warn("material",error.message);continue}
      pm.unsynced=false;}
    await saveMaterialsLocal();
  }finally{matSyncBusy=false}
}
function renderPhotos(){const j=S.editing;const box=document.getElementById("photos");if(!box)return;
  box.innerHTML=j.photos.map((p,i)=>`<div class="ph">${photoImg(p,STAGES[p.stage]+" photo")}<div class="cap"><b>${STAGES[p.stage]}</b> · ${new Date(p.ts).toLocaleTimeString("en-ZA",{hour:"2-digit",minute:"2-digit"})}${p.lat?" · GPS":""}</div><button class="x" data-px="${i}" aria-label="Remove photo">×</button></div>`).join("")||`<p class="note" style="margin:0;grid-column:1/-1">No photos yet. Take a before photo when you arrive.</p>`;
  box.querySelectorAll("[data-px]").forEach(b=>b.onclick=async()=>{if(await confirmBox("Remove this photo?","Remove")){const [p]=j.photos.splice(+b.dataset.px,1);if(p.uploaded)(j.removedPhotos=j.removedPhotos||[]).push({id:p.id,path:p.path});renderPhotos();autosave()}});
  hydratePhotos(box);
}
let gpsCache=null;
function getGPS(){return new Promise(res=>{if(!navigator.geolocation)return res(null);if(gpsCache&&Date.now()-gpsCache.t<120000)return res(gpsCache);
  try{navigator.geolocation.getCurrentPosition(p=>{gpsCache={lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy,t:Date.now()};res(gpsCache)},()=>res(null),{enableHighAccuracy:true,timeout:8000,maximumAge:120000})}catch(e){res(null)}})}
async function addPhoto(file,stage){
  const j=S.editing;if(!CLOUD&&isTempNo(j.no))assignLocalNo(j);
  const [img,gps]=await Promise.all([new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=URL.createObjectURL(file)}),getGPS()]).catch(()=>[null,null]);
  if(!img){toast("That file could not be read as a photo");return}
  const max=1600,sc=Math.min(1,max/Math.max(img.width,img.height));
  const cv=document.createElement("canvas");cv.width=Math.round(img.width*sc);cv.height=Math.round(img.height*sc);
  const g=cv.getContext("2d");g.drawImage(img,0,0,cv.width,cv.height);URL.revokeObjectURL(img.src);
  const ts=Date.now();const d=new Date(ts);const cl=client(j.clientId);
  const lines=[`${STAGES[stage].toUpperCase()}${cl?" · "+cl.name:""}${isTempNo(j.no)?"":" · "+j.no}`,d.toLocaleDateString("en-ZA")+" "+d.toLocaleTimeString("en-ZA"),gps?`GPS ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} (±${Math.round(gps.acc)}m)`:"GPS not available"];
  const fs=Math.max(14,Math.round(cv.width/45));g.font=`600 ${fs}px sans-serif`;
  const bh=fs*1.35*lines.length+fs*.8;g.fillStyle="rgba(0,0,0,.55)";g.fillRect(0,cv.height-bh,cv.width,bh);
  g.fillStyle="#fff";lines.forEach((l,i)=>g.fillText(l,fs*.6,cv.height-bh+fs*1.25*(i+1)));
  j.photos.push({id:uuid(),stage,ts,lat:gps?.lat??null,lng:gps?.lng??null,acc:gps?.acc??null,data:cv.toDataURL("image/jpeg",.72),w:cv.width,h:cv.height,uploaded:false});
  renderPhotos();await persist(j);
}
function assignLocalNo(j){j.no=`${S.settings.prefix||"FFR"}-${String(S.settings.nextNo).padStart(4,"0")}`;S.settings.nextNo++;saveSettingsLocal()}
let saveT;function autosave(){clearTimeout(saveT);saveT=setTimeout(()=>persist(S.editing),500)}
async function persist(j){if(!j)return;
  if(!CLOUD&&isTempNo(j.no))assignLocalNo(j);
  if(CLOUD&&!j.no)j.no="NEW-"+j.id.slice(0,6);
  j.dirty=true;await Store.put("jobs",j);const i=S.jobs.findIndex(x=>x.id===j.id);if(i<0)S.jobs.push(j);else S.jobs[i]=j;setNet()}
async function finish(){
  const j=S.editing;const miss=[];
  if(!j.clientId)miss.push("client");if(!j.type)miss.push("type of job");if(!j.work.trim())miss.push("work done");if(!j.timeOut)miss.push("time you left");if(!j.techSig)miss.push("technician signature");
  if(j.type==="nonsla"&&!j.reasons.length)miss.push("reason it is non-SLA");
  if(miss.length){toast("Still needed: "+miss.join(", "));return}
  if(j.type==="nonsla"&&!j.photos.some(p=>p.stage==="before")){if(!await confirmBox("There is no before photo of the damage. The client may dispute the charge without one. Sign off anyway?","Sign off anyway"))return}
  if(!j.clientSig){if(!await confirmBox("The client has not signed. Sign off without a client signature?","Sign off"))return}
  j.status="done";j.signedAt=Date.now();await persist(j);toast(CLOUD&&!navigator.onLine?"Job signed off. It will send when you have signal.":"Job signed off");go("job",j.id);syncNow();
}

/* signature pad */
function sigBlock(k,label,val){return`<div class="sig"><div class="hint"><span>${label}</span><button type="button" class="btn small ghost" id="sig-clear-${k}">Clear</button></div><canvas id="sig-${k}" aria-label="${label}"></canvas>${val?"":`<span class="note">Sign with your finger in the box.</span>`}</div>`}
function initSig(k,onChange){
  const cv=document.getElementById("sig-"+k);
  const fit=()=>{const r=cv.getBoundingClientRect();const dpr=window.devicePixelRatio||1;cv.width=r.width*dpr;cv.height=r.height*dpr;const g=cv.getContext("2d");g.scale(dpr,dpr);g.lineWidth=2.2;g.lineCap="round";g.lineJoin="round";g.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue("--fg").trim()||"#000";
    const v=k==="tech"?S.editing.techSig:S.editing.clientSig;if(v){const im=new Image();im.onload=()=>g.drawImage(im,0,0,r.width,r.height);im.src=v}};
  fit();let drawing=false,last=null,dirty=false;const g=()=>cv.getContext("2d");
  const pos=e=>{const r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}};
  cv.addEventListener("pointerdown",e=>{drawing=true;last=pos(e);cv.setPointerCapture(e.pointerId);e.preventDefault()});
  cv.addEventListener("pointermove",e=>{if(!drawing)return;const p=pos(e);const c=g();c.beginPath();c.moveTo(last.x,last.y);c.lineTo(p.x,p.y);c.stroke();last=p;dirty=true});
  const end=()=>{if(!drawing)return;drawing=false;if(dirty){onChange(exportSig(cv))}};
  cv.addEventListener("pointerup",end);cv.addEventListener("pointercancel",end);
  document.getElementById("sig-clear-"+k).onclick=()=>{g().clearRect(0,0,cv.width,cv.height);dirty=false;onChange("")};
}
function exportSig(cv){/* stored as dark ink on transparent so it prints well */const o=document.createElement("canvas");o.width=cv.width;o.height=cv.height;const c=o.getContext("2d");c.drawImage(cv,0,0);c.globalCompositeOperation="source-in";c.fillStyle="#10263a";c.fillRect(0,0,o.width,o.height);return o.toDataURL("image/png")}

/* ---------- job detail ---------- */
function vJob(){
  const j=S.jobs.find(x=>x.id===S.arg);if(!j)return go("jobs");const c=client(j.clientId)||{};
  view.innerHTML=`<h1><span class="mono">${esc(isTempNo(j.no)?"New job":j.no)}</span></h1><div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:14px">${typePill(j.type)}<span class="pill ${j.status==="done"?"done":"draft"}">${j.status==="done"?"Signed off":"In progress"}</span>${j.type==="nonsla"?`<span class="pill ${j.invoiced?"done":"nonsla"}">${j.invoiced?"Invoiced":"Not yet invoiced"}</span>`:""}${j.example?'<span class="pill ex">Example</span>':""}${CLOUD&&j.dirty?'<span class="pill nonsla">Not sent to office yet</span>':""}</div>
  ${j.syncError?`<div class="callout" style="margin-bottom:12px">This job couldn't be sent: ${esc(j.syncError)}</div>`:""}
  <div class="stack">
  <section class="section"><dl class="kv">
   <dt>Client</dt><dd>${esc(c.name||"—")}</dd><dt>Site</dt><dd>${esc([c.site,j.site].filter(Boolean).join(" · ")||"—")}</dd>
   <dt>SLA</dt><dd>${esc(c.sla||"—")}</dd><dt>Date</dt><dd>${fmtDate(j.date)}, ${esc(j.timeIn)}–${esc(j.timeOut||"…")} (${jobHours(j)} h)</dd>
   <dt>Technician</dt><dd>${esc(j.techName||"—")}</dd>${j.type==="nonsla"?`<dt>Estimated charge</dt><dd>${R(jobAmount(j))} <span class="note">(call-out + ${jobHours(j)} h labour + materials, excl. VAT)</span></dd>`:""}
  </dl></section>
  ${j.type==="nonsla"?`<section class="section"><h2>Why this is not covered by the SLA</h2><div class="chips">${j.reasons.map(r=>`<span class="pill nonsla" style="text-transform:none;letter-spacing:0;font-size:13px">${esc(r)}</span>`).join("")}</div>${j.reasonNote?`<p style="margin:0">${esc(j.reasonNote)}</p>`:""}<p class="note" style="margin:0">${j.ack?"Client agreed on site that this work is chargeable.":"Client has not acknowledged the charge."}</p></section>`:""}
  <section class="section"><h2>Work</h2><dl class="kv"><dt>Reported</dt><dd>${esc(j.fault||"—")}</dd><dt>Found</dt><dd>${esc(j.findings||"—")}</dd><dt>Done</dt><dd>${esc(j.work||"—")}</dd><dt>Materials</dt><dd>${j.materials.filter(m=>m.item).map(m=>esc((m.qty?m.qty+" × ":"")+m.item)+(m.pending?' <span class="pill nonsla" style="text-transform:none;letter-spacing:0">Price pending</span>':m.price?` <span class="note">@ ${R(m.price)} = ${R(lineTotal(m))}</span>`:"")).join("<br>")||"—"}${matTotal(j)?`<br><b>Total ${R(matTotal(j))}</b>`:""}</dd></dl></section>
  <section class="section"><h2>Photos (${j.photos.length})</h2><div class="photos">${j.photos.map(p=>`<div class="ph">${photoImg(p,STAGES[p.stage]+" photo")}<div class="cap"><b>${STAGES[p.stage]}</b> · ${new Date(p.ts).toLocaleString("en-ZA",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</div></div>`).join("")||'<p class="note" style="margin:0">No photos.</p>'}</div></section>
  <section class="section"><h2>Signatures</h2><div class="row"><div><div class="note">Technician: ${esc(j.techName||"—")}</div>${j.techSig?`<img src="${j.techSig}" alt="Technician signature" style="max-height:80px;background:#fff;border-radius:6px">`:'<p class="note">Not signed</p>'}</div><div><div class="note">Client: ${esc(j.clientName||"—")}</div>${j.clientSig?`<img src="${j.clientSig}" alt="Client signature" style="max-height:80px;background:#fff;border-radius:6px">`:'<p class="note">Not signed</p>'}</div></div></section>
  <div class="actions"><button class="btn primary" id="pdf">Download job report (PDF)</button>${canEditJob(j)?'<button class="btn" id="edit">Edit job</button>':""}</div>
  ${j.type==="nonsla"&&isAdmin()?`<div class="actions"><button class="btn" id="inv">${j.invoiced?"Mark as not invoiced":"Mark as invoiced"}</button></div>`:""}
  </div>`;
  const ed=document.getElementById("edit");if(ed)ed.onclick=()=>{S.editing=j;go("edit")};
  document.getElementById("pdf").onclick=async e=>{const b=e.currentTarget;b.disabled=true;b.textContent="Preparing report…";try{await jobPDF(j)}finally{b.disabled=false;b.textContent="Download job report (PDF)"}};
  const inv=document.getElementById("inv");if(inv)inv.onclick=async()=>{j.invoiced=!j.invoiced;await persist(j);syncNow();vJob();toast(j.invoiced?"Marked as invoiced":"Marked as not invoiced")};
}

/* ---------- PDF report ---------- */
function pdfLib(){if(!window.jspdf){toast("The PDF tool hasn't loaded yet. Connect to the internet once and try again.");return null}return window.jspdf.jsPDF}
function pdfHeader(doc,W,M,title,right1,right2){
  const st=S.settings;doc.setFillColor(10,111,143);doc.rect(0,0,W,26,"F");let tx=M;
  if(st.logo){const lh=18,lw=Math.min(60,lh*(st.logoW||3)/(st.logoH||1));doc.setFillColor(255,255,255);doc.roundedRect(M-2,4,lw+4,lh,1.5,1.5,"F");try{doc.addImage(st.logo,"JPEG",M,5,lw,lh-2)}catch(e){}tx=M+lw+8}
  doc.setTextColor(255);doc.setFont("helvetica","bold");doc.setFontSize(17);doc.text(st.company||"FFR Comms",tx,12);
  doc.setFont("helvetica","normal");doc.setFontSize(10);doc.text(title,tx,19);
  if(right1){doc.setFont("courier","bold");doc.setFontSize(14);doc.text(right1,W-M,12,{align:"right"})}
  if(right2){doc.setFont("helvetica","normal");doc.setFontSize(9);doc.text(right2,W-M,19,{align:"right"})}
}
async function jobPDF(j){
  const JS=pdfLib();if(!JS)return;const c=client(j.clientId)||{};
  if(CLOUD&&isTempNo(j.no)&&navigator.onLine)await syncNow();
  const photos=[];for(const p of j.photos){const d=await photoData(p);if(d)photos.push({...p,data:d})}
  const doc=new JS({unit:"mm",format:"a4"});const W=210,M=14;let y=0;
  const col={ink:[21,34,43],muted:[90,107,116],acc:[10,111,143],non:[194,65,12],sla:[31,138,76],inst:[91,75,183],maint:[107,114,128],line:[213,221,224]};
  const tc={sla:col.sla,nonsla:col.non,install:col.inst,maint:col.maint}[j.type]||col.maint;
  const ensure=h=>{if(y+h>282){doc.addPage();y=18}};
  pdfHeader(doc,W,M,"Job report",isTempNo(j.no)?"":j.no,fmtDate(j.date));
  y=34;
  doc.setFillColor(...tc);doc.rect(M,y,W-2*M,10,"F");doc.setTextColor(255);doc.setFont("helvetica","bold");doc.setFontSize(11);
  doc.text(j.type==="nonsla"?"NON-SLA: CHARGEABLE WORK":j.type==="sla"?"SLA CALL: COVERED UNDER SERVICE AGREEMENT":(TYPES[j.type]?.label||"Job").toUpperCase(),M+4,y+6.6);y+=16;
  const kv=(rows)=>{doc.setFontSize(9.5);rows.forEach(([k,v])=>{const lines=doc.splitTextToSize(String(v||"—"),W-2*M-40);ensure(lines.length*4.6+2);doc.setFont("helvetica","bold");doc.setTextColor(...col.muted);doc.text(k,M,y);doc.setFont("helvetica","normal");doc.setTextColor(...col.ink);doc.text(lines,M+40,y);y+=lines.length*4.6+1.8})};
  const head=t=>{ensure(14);y+=2;doc.setFont("helvetica","bold");doc.setFontSize(10);doc.setTextColor(...col.acc);doc.text(t.toUpperCase(),M,y);doc.setDrawColor(...col.line);doc.line(M,y+1.8,W-M,y+1.8);y+=7};
  head("Client and site");
  kv([["Client",c.name],["Address",c.site],["Area on site",j.site],["Contact",c.contact],["Service agreement",c.sla],["Date and time",`${fmtDate(j.date)}, ${j.timeIn} to ${j.timeOut||"…"} (${jobHours(j)} hours on site)`],["Technician",j.techName]]);
  if(j.type==="nonsla"){head("Reason work is not covered by the SLA");kv([["Cause",j.reasons.join("; ")],["Details",j.reasonNote],...(c.excludes?[["SLA exclusions",c.excludes]]:[])]);}
  head("Work carried out");kv([["Fault reported",j.fault],["Findings",j.findings],["Work done",j.work]]);
  const mats=j.materials.filter(m=>m.item);
  if(mats.length){head("Materials used");const priced=j.type==="nonsla";doc.setFontSize(9.5);
    const hdr=()=>{doc.setFont("helvetica","bold");doc.setTextColor(...col.muted);doc.text("Item",M,y);doc.text("Qty",priced?W-M-68:W-M,y,{align:"right"});if(priced){doc.text("Unit price",W-M-30,y,{align:"right"});doc.text("Amount",W-M,y,{align:"right"})}y+=5;doc.setFont("helvetica","normal")};hdr();
    mats.forEach(m=>{const nm=doc.splitTextToSize(m.item,priced?W-2*M-80:W-2*M-30);ensure(nm.length*4.6+2);doc.setTextColor(...col.ink);doc.text(nm,M,y);doc.text(`${m.qty||""}${m.unit&&m.unit!=="each"?" "+m.unit:""}`,priced?W-M-68:W-M,y,{align:"right"});
      if(priced){doc.text(m.pending?"pending":m.price?R(m.price):"—",W-M-30,y,{align:"right"});doc.text(m.pending?"—":R(lineTotal(m)),W-M,y,{align:"right"})}y+=nm.length*4.6+0.8});
    if(priced){ensure(7);doc.setDrawColor(...col.line);doc.line(W-M-70,y-2.5,W-M,y-2.5);doc.setFont("helvetica","bold");doc.text("Materials total",W-M-30,y+1.5,{align:"right"});doc.text(R(matTotal(j)),W-M,y+1.5,{align:"right"});doc.setFont("helvetica","normal");y+=7}}
  if(j.type==="nonsla"){head("Charges (estimate)");kv([["Call-out fee",R(c.callout)],["Labour",`${jobHours(j)} h × ${R(c.rate)}/h = ${R(jobHours(j)*(+c.rate||0))}`],["Materials",R(matTotal(j))],["Total (excl. VAT)",R(jobAmount(j))]])}
  if(photos.length){head(`Photos (${photos.length})`);const gw=(W-2*M-6)/2;let cx=0,lastH=60;
    for(const st of["before","during","after"]){for(const p of photos.filter(p=>p.stage===st)){const h=Math.min(gw*((p.h||3)/(p.w||4)),70);if(cx===0)ensure(h+10);const x=M+cx*(gw+6);
      try{doc.addImage(p.data,"JPEG",x,y,gw,h)}catch(e){}
      doc.setFont("helvetica","normal");doc.setFontSize(8);doc.setTextColor(...col.muted);doc.text(`${STAGES[p.stage]} · ${new Date(p.ts).toLocaleString("en-ZA")}${p.lat?` · ${(+p.lat).toFixed(5)}, ${(+p.lng).toFixed(5)}`:""}`,x,y+h+4);
      if(cx===1){y+=Math.max(h,lastH)+9;cx=0}else{cx=1;lastH=h}}}
    if(cx===1)y+=lastH+9;}
  head("Sign-off");ensure(48);
  if(j.type==="nonsla"){const t=doc.splitTextToSize(j.ack?"The client representative below confirms that the fault described above was not covered by the service agreement and that this work is chargeable.":"The client representative did not confirm the charge on site.",W-2*M);doc.setFont("helvetica","normal");doc.setFontSize(9);doc.setTextColor(...col.ink);doc.text(t,M,y);y+=t.length*4.4+3}
  const sw=(W-2*M-10)/2;[[j.techName,j.techSig,"Technician"],[j.clientName,j.clientSig,"Client representative"]].forEach(([n,s,l],i)=>{const x=M+i*(sw+10);if(s){try{doc.addImage(s,"PNG",x,y,Math.min(sw,60),22)}catch(e){}}doc.setDrawColor(...col.muted);doc.line(x,y+24,x+sw,y+24);doc.setFont("helvetica","normal");doc.setFontSize(8.5);doc.setTextColor(...col.muted);doc.text(`${l}: ${n||""}`,x,y+28.5)});
  y+=34;if(j.signedAt){doc.setFontSize(8);doc.text("Signed off "+new Date(j.signedAt).toLocaleString("en-ZA"),M,y)}
  const pc=doc.getNumberOfPages();for(let i=1;i<=pc;i++){doc.setPage(i);doc.setFontSize(8);doc.setTextColor(...col.muted);doc.text(`${S.settings.company||"FFR Comms"} · ${isTempNo(j.no)?"":j.no} · page ${i} of ${pc}`,W/2,292,{align:"center"})}
  await saveFile(`${isTempNo(j.no)?"Job":j.no} ${(c.name||"").replace(/[^\w\- ]+/g,"").trim()}.pdf`.replace(/\s+/g," ").trim(),doc.output("blob"));
}

/* ---------- billing ---------- */
function vBilling(){
  const m=S.billMonth;const list=S.jobs.filter(j=>j.type==="nonsla"&&j.date.startsWith(m)).sort((a,b)=>a.date.localeCompare(b.date));
  const tot=list.reduce((s,j)=>s+jobAmount(j),0),open=list.filter(j=>!j.invoiced);
  view.innerHTML=`<h1>Billing</h1><p class="lead">Non-SLA work to invoice. Amounts are call-out, labour at each client's rate and materials from the price list, before VAT.</p>
  <div class="toolbar"><label class="f" style="flex:0 1 200px">Month<input type="month" id="bm" value="${m}" style="width:100%;font:inherit;color:var(--fg);background:var(--surface2);border:1px solid var(--line);border-radius:8px;padding:10px 11px;min-height:44px"></label></div>
  <div class="stats"><div class="stat non"><b>${list.length}</b><span>Non-SLA jobs</span></div><div class="stat"><b>${open.length}</b><span>Not invoiced</span></div><div class="stat"><b style="font-size:17px">${R(tot)}</b><span>Est. value</span></div></div>
  ${list.length?`<div class="section"><div class="tblwrap"><table class="bill"><thead><tr><th>Job</th><th>Client / cause</th><th class="n">Hours</th><th class="n">Est.</th><th>Billed</th></tr></thead><tbody>${list.map(j=>`<tr><td><a href="#" data-open="${j.id}" class="mono">${esc(isTempNo(j.no)?"New":j.no)}</a><br><span class="note">${fmtDate(j.date)}</span></td><td>${esc(client(j.clientId)?.name||"—")}<br><span class="note">${esc(j.reasons.join("; "))}</span></td><td class="n">${jobHours(j)}</td><td class="n">${R(jobAmount(j))}${pendingLines(j)?'<br><span class="note" style="color:var(--non)">price pending</span>':""}</td><td><input type="checkbox" data-inv="${j.id}" ${j.invoiced?"checked":""} ${isAdmin()?"":"disabled"} aria-label="Invoiced"></td></tr>`).join("")}</tbody></table></div></div>
  <div class="actions" style="margin-top:12px"><button class="btn primary" id="bpdf">Download month summary (PDF)</button><button class="btn" id="bcsv">Download for spreadsheet (CSV)</button></div>`:`<div class="empty">No non-SLA jobs logged for this month.</div>`}`;
  document.getElementById("bm").onchange=e=>{S.billMonth=e.target.value||today().slice(0,7);vBilling()};
  view.querySelectorAll("[data-open]").forEach(a=>a.onclick=e=>{e.preventDefault();go("job",a.dataset.open)});
  view.querySelectorAll("[data-inv]").forEach(cb=>cb.onchange=async()=>{const j=S.jobs.find(x=>x.id===cb.dataset.inv);j.invoiced=cb.checked;await persist(j);syncNow();vBilling()});
  const bc=document.getElementById("bcsv");if(bc)bc.onclick=()=>{const rows=[["Job no","Date","Client","Site","Technician","Cause","Details","Time in","Time out","Hours","Call-out","Rate","Labour","Materials amount","Estimated amount","Materials","Client acknowledged","Invoiced"]].concat(list.map(j=>{const c=client(j.clientId)||{};return[j.no,j.date,c.name,j.site,j.techName,j.reasons.join("; "),j.reasonNote,j.timeIn,j.timeOut,jobHours(j),c.callout||0,c.rate||0,labour(j).toFixed(2),matTotal(j).toFixed(2),jobAmount(j).toFixed(2),j.materials.filter(x=>x.item).map(x=>`${x.qty} x ${x.item}`).join("; "),j.ack?"Yes":"No",j.invoiced?"Yes":"No"]}));
    saveFile(`Non-SLA jobs ${m}.csv`,new Blob(["﻿"+rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\r\n")],{type:"text/csv"}))};
  const bp=document.getElementById("bpdf");if(bp)bp.onclick=()=>{const JS=pdfLib();if(!JS)return;const doc=new JS({unit:"mm",format:"a4",orientation:"landscape"});const W=297,M=12;
    pdfHeader(doc,W,M,`Non-SLA work for ${new Date(m+"-01T00:00:00").toLocaleDateString("en-ZA",{month:"long",year:"numeric"})}`,"","");
    let y=34;const cols=[[M,"Job"],[M+28,"Date"],[M+52,"Client"],[M+112,"Cause"],[M+200,"Hours"],[M+222,"Est. amount"],[M+256,"Invoiced"]];
    const hdr=()=>{doc.setFontSize(9);doc.setTextColor(90,107,116);doc.setFont("helvetica","bold");cols.forEach(([x,t])=>doc.text(t,x,y));y+=6;doc.setFont("helvetica","normal")};hdr();
    list.forEach(j=>{const c=client(j.clientId)||{};const cause=doc.splitTextToSize(j.reasons.join("; ")||"—",84);const cn=doc.splitTextToSize(c.name||"—",56);const h=Math.max(cause.length,cn.length)*4.2+2;if(y+h>195){doc.addPage();y=16;hdr()}
      doc.setTextColor(21,34,43);doc.text(j.no||"",cols[0][0],y);doc.text(fmtDate(j.date),cols[1][0],y);doc.text(cn,cols[2][0],y);doc.text(cause,cols[3][0],y);doc.text(String(jobHours(j)),cols[4][0],y);doc.text(R(jobAmount(j)),cols[5][0],y);doc.text(j.invoiced?"Yes":"No",cols[6][0],y);y+=h;doc.setDrawColor(213,221,224);doc.line(M,y-2,W-M,y-2)});
    y+=4;doc.setFont("helvetica","bold");doc.text(`Total estimated: ${R(tot)}  ·  Not yet invoiced: ${R(open.reduce((s,j)=>s+jobAmount(j),0))}`,M,y);
    saveFile(`Non-SLA summary ${m}.pdf`,doc.output("blob"))};
}

/* ---------- clients ---------- */
function vClients(){
  view.innerHTML=`<h1>Clients</h1><p class="lead">What each SLA covers, and the rates used for chargeable work.${isAdmin()?"":" Only the office can add or change clients."}</p>
  <div class="actions" style="margin-bottom:12px">${isAdmin()?'<button class="btn primary" id="nc">+ Add client</button>':""}<button class="btn" id="go-mats">Materials price list (${S.materials.length})${isAdmin()&&needsPriceList().length?` · ${needsPriceList().length} need a price`:""}</button></div>
  <div class="jobs">${S.clients.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(c=>{const n=S.jobs.filter(j=>j.clientId===c.id).length;return`<button class="job" data-id="${c.id}" data-t="${/no sla/i.test(c.sla||"")||!c.sla?"maint":"sla"}"><span class="stripe"></span><span class="body"><span class="l1"><span class="client">${esc(c.name)}</span>${c.example?'<span class="pill ex">Example</span>':""}</span><span class="meta">${esc(c.sla||"No SLA on file")}</span><span class="meta">${n} job${n===1?"":"s"} · ${R(c.rate)}/h · call-out ${R(c.callout)}</span></span></button>`}).join("")||`<div class="empty">No clients yet.${isAdmin()?" Tap <b>Add client</b> to set up your first one.":""}</div>`}</div>`;
  const nc=document.getElementById("nc");if(nc)nc.onclick=()=>go("client","new");
  document.getElementById("go-mats").onclick=()=>go("materials");
  view.querySelectorAll(".job").forEach(el=>el.onclick=()=>go("client",el.dataset.id));
}
function vClient(){
  const isNew=S.arg==="new";const c=isNew?{id:uuid(),name:"",site:"",contact:"",sla:"",covers:"",excludes:"",rate:"",callout:""}:{...client(S.arg)};
  const ro=!isAdmin();const dis=ro?"disabled":"";
  view.innerHTML=`<h1>${isNew?"New client":esc(c.name)}</h1><div class="section">
  <label class="f">Client name<input type="text" id="c-name" value="${esc(c.name)}" ${dis}></label>
  <label class="f">Address<input type="text" id="c-site" value="${esc(c.site)}" ${dis}></label>
  <label class="f">Contact person and number<input type="text" id="c-contact" value="${esc(c.contact)}" ${dis}></label>
  <label class="f">SLA (level, response time, hours)<input type="text" id="c-sla" value="${esc(c.sla)}" placeholder="e.g. Gold · 4h response · Mon–Fri 07:00–18:00, or No SLA" ${dis}></label>
  <label class="f">What the SLA covers<textarea id="c-covers" ${dis}>${esc(c.covers)}</textarea></label>
  <label class="f">What it does not cover<textarea id="c-excludes" placeholder="e.g. Damage by client or contractors, cut or removed cables, after hours" ${dis}>${esc(c.excludes)}</textarea></label>
  <div class="row"><label class="f">Labour rate (R per hour)<input type="number" id="c-rate" inputmode="decimal" value="${esc(c.rate)}" ${dis}></label><label class="f">Call-out fee (R)<input type="number" id="c-callout" inputmode="decimal" value="${esc(c.callout)}" ${dis}></label></div>
  <div class="actions"><button class="btn" id="c-cancel">${ro?"Back":"Cancel"}</button>${ro?"":'<button class="btn primary" id="c-save">Save client</button>'}</div>
  ${isNew||ro?"":`<div class="actions"><button class="btn danger" id="c-del">Delete client</button></div>`}</div>`;
  const v=id=>document.getElementById(id).value.trim();
  const back=()=>{if(S.returnToEdit){S.returnToEdit=false;go("edit")}else go("clients")};
  document.getElementById("c-cancel").onclick=back;
  const sv=document.getElementById("c-save");if(sv)sv.onclick=async()=>{const n={...c,name:v("c-name"),site:v("c-site"),contact:v("c-contact"),sla:v("c-sla"),covers:v("c-covers"),excludes:v("c-excludes"),rate:+v("c-rate")||0,callout:+v("c-callout")||0};if(!n.name){toast("Give the client a name");return}
    if(n.example&&!n.name.startsWith("Example"))n.example=false;
    if(CLOUD){if(needOnline())return;const{error}=await sb.from("clients").upsert(clientToRow(n));if(error){toast("Couldn't save: "+error.message);return}}
    await Store.put("clients",n);const i=S.clients.findIndex(x=>x.id===n.id);if(i<0)S.clients.push(n);else S.clients[i]=n;toast("Client saved");if(S.returnToEdit&&S.editing){S.editing.clientId=n.id;persist(S.editing)}back()};
  const d=document.getElementById("c-del");if(d)d.onclick=async()=>{const used=S.jobs.some(j=>j.clientId===c.id);if(used){toast("This client has jobs logged, so it can't be deleted");return}if(await confirmBox("Delete this client?","Delete")){
    if(CLOUD){if(needOnline())return;const{error}=await sb.from("clients").delete().eq("id",c.id);if(error){toast("Couldn't delete: "+error.message);return}}
    await Store.del("clients",c.id);S.clients=S.clients.filter(x=>x.id!==c.id);go("clients")}};
}

/* ---------- materials price list ---------- */
function vMaterials(){
  const ed=isAdmin();const list=S.materials.slice().sort((a,b)=>a.name.localeCompare(b.name));const q=(S.matQ||"").toLowerCase();
  const shown=list.filter(m=>!m.needsPrice&&(!q||m.name.toLowerCase().includes(q)));
  const need=list.filter(m=>m.needsPrice);
  const usedOn=m=>S.jobs.filter(j=>j.materials.some(x=>x.materialId===m.id&&x.pending)).length;
  view.innerHTML=`<h1>Materials price list</h1><p class="lead">${ed?"Prices you set here fill in automatically when technicians add materials to a job. Changing a price doesn't change jobs already logged.":"Prices set by the office. Pick these when you add materials to a job."}</p>
  ${need.length?`<section class="section needprice" style="margin-bottom:14px"><h2>Needs a price (${need.length})</h2>
    <p class="note" style="margin:0">${ed?"Technicians added these on site. Set a price and it fills in on every job still waiting for it.":"Added by technicians. The office will set the prices."}</p>
    <div class="mlist">${need.map(m=>`<div class="mrow" data-id="${m.id}">
      <div class="mname"><b>${esc(m.name)}</b><div class="note">${m.addedBy?"Added by "+esc(m.addedBy)+" · ":""}${usedOn(m)} job${usedOn(m)===1?"":"s"} waiting${CLOUD&&m.unsynced?" · not sent yet":""}</div></div>
      ${ed?`<label class="f">Unit<select data-f="unit">${[...new Set([...UNITS,m.unit])].map(u=>`<option ${u===m.unit?"selected":""}>${esc(u)}</option>`).join("")}</select></label>
      <label class="f">Price (R)<input type="number" step="0.01" inputmode="decimal" data-setprice placeholder="0.00"></label>
      <button class="btn small ghost" data-del="${m.id}" aria-label="Remove ${esc(m.name)}">✕</button>`:`<div class="note">${esc(m.unit)}</div>`}</div>`).join("")}</div></section>`:""}
  ${ed?`<form class="section" id="mf" style="margin-bottom:14px"><h2>Add material</h2>
    <label class="f">Material<input type="text" id="mf-name" placeholder="e.g. CAT6 cable" required></label>
    <div class="row"><label class="f">Unit<select id="mf-unit">${["each","m","box","roll","pack","hour","set"].map(u=>`<option>${u}</option>`).join("")}</select></label><label class="f">Price (R, excl. VAT)<input type="number" step="0.01" inputmode="decimal" id="mf-price" placeholder="0.00" required></label></div>
    <div class="actions"><button class="btn primary" type="submit">Add to price list</button></div></form>`:""}
  ${list.length>8?`<div class="toolbar"><input type="search" id="mq" placeholder="Search materials…" value="${esc(S.matQ||"")}" aria-label="Search materials"></div>`:""}
  ${shown.length?`<div class="section">${ed?`<div class="mlist">${shown.map(m=>`<div class="mrow" data-id="${m.id}">
     <label class="f mname">Material${m.example?' <span class="pill ex">Example</span>':""}<input type="text" data-f="name" value="${esc(m.name)}"></label>
     <label class="f">Unit<select data-f="unit">${[...new Set(["each","m","box","roll","pack","hour","set",m.unit])].map(u=>`<option ${u===m.unit?"selected":""}>${esc(u)}</option>`).join("")}</select></label>
     <label class="f">Price (R)<input type="number" step="0.01" inputmode="decimal" data-f="price" value="${m.price}"></label>
     <button class="btn small ghost" data-del="${m.id}" aria-label="Remove ${esc(m.name)}">✕</button></div>`).join("")}</div><p class="note" style="margin:0">Changes save when you leave a box.</p>`
    :`<div class="tblwrap"><table class="bill"><thead><tr><th>Material</th><th>Unit</th><th class="n">Price</th></tr></thead><tbody>${shown.map(m=>`<tr><td>${esc(m.name)}</td><td>${esc(m.unit)}</td><td class="n">${R(m.price)}</td></tr>`).join("")}</tbody></table></div>`}</div>`:`<div class="empty">${list.length?"No materials match.":ed?"No materials yet. Add your first one above.":"The office hasn't added any materials yet."}</div>`}
  <div class="actions" style="margin-top:12px"><button class="btn" id="m-back">Back to clients</button></div>`;
  const $=id=>document.getElementById(id);
  $("m-back").onclick=()=>go("clients");
  if($("mq"))$("mq").oninput=e=>{S.matQ=e.target.value;const p=e.target.selectionStart;vMaterials();const n=$("mq");n.focus();n.setSelectionRange(p,p)};
  if($("mf"))$("mf").onsubmit=async e=>{e.preventDefault();const m={id:uuid(),name:$("mf-name").value.trim(),unit:$("mf-unit").value,price:parseFloat($("mf-price").value)||0};
    if(!m.name)return;if(matByName(m.name)){toast("That material is already on the list");return}
    if(!await saveMaterial(m))return;S.materials.push(m);await saveMaterialsLocal();toast("Added "+m.name);vMaterials();$("mf-name").focus()};
  view.querySelectorAll(".mrow [data-f]").forEach(inp=>inp.onchange=async()=>{const m=S.materials.find(x=>x.id===inp.closest(".mrow").dataset.id);const old={...m};
    const f=inp.dataset.f;const v=f==="price"?(parseFloat(inp.value)||0):inp.value.trim();if(f==="name"&&!v){inp.value=m.name;return}
    m[f]=v;if(f==="name")m.example=false;if(!await saveMaterial(m)){Object.assign(m,old);vMaterials();return}await saveMaterialsLocal();toast("Saved")});
  view.querySelectorAll("[data-setprice]").forEach(inp=>inp.onchange=async()=>{const m=S.materials.find(x=>x.id===inp.closest(".mrow").dataset.id);const v=parseFloat(inp.value)||0;if(v<=0)return;
    const old={...m};m.price=v;m.needsPrice=false;if(!await saveMaterial(m)){Object.assign(m,old);vMaterials();return}m.unsynced=false;await saveMaterialsLocal();const n=await applyPrices();syncNow();
    toast(`${m.name} priced at ${R(v)}${n?`, ${n} job${n>1?"s":""} updated`:""}`);vMaterials()});
  view.querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{const m=S.materials.find(x=>x.id===b.dataset.del);
    if(!await confirmBox(`Remove ${m.name} from the price list? Jobs already logged keep their prices.`,"Remove"))return;
    if(CLOUD&&!m.example){if(needOnline())return;const{error}=await sb.from("materials").delete().eq("id",m.id);if(error){toast("Couldn't remove: "+error.message);return}}
    S.materials=S.materials.filter(x=>x.id!==m.id);await saveMaterialsLocal();vMaterials()});
}
async function saveMaterial(m){
  if(!CLOUD)return true;if(needOnline())return false;
  const{error}=await sb.from("materials").upsert({id:m.id,name:m.name,unit:m.unit,price:m.price,needs_price:!!m.needsPrice,updated_at:new Date().toISOString()});
  if(error){toast(/relation|does not exist|schema cache/i.test(error.message)?"The price list isn't switched on in the database yet. Try again shortly.":"Couldn't save: "+error.message);return false}
  return true;
}

/* ---------- me / office settings ---------- */
function vSettings(){
  const st=S.settings;const ex=S.jobs.filter(j=>j.example).length+S.clients.filter(c=>c.example).length+S.materials.filter(m=>m.example).length;
  const pending=S.team.filter(p=>!p.active);
  view.innerHTML=`<h1>${CLOUD&&isAdmin()?"Me and office":"Me"}</h1><div class="stack">
  <section class="section"><h2>${CLOUD?"Signed in":"Technician"}</h2>
   ${CLOUD?`<dl class="kv"><dt>Name</dt><dd>${esc(S.profile.full_name)}</dd><dt>Email</dt><dd>${esc(S.user.email)}</dd><dt>Role</dt><dd>${isAdmin()?"Office (admin)":"Technician"}</dd><dt>Last synced</dt><dd>${S.sync.last?new Date(S.sync.last).toLocaleString("en-ZA"):"Not yet"}</dd></dl>
     <div class="actions"><button class="btn" id="m-sync">Sync now</button><button class="btn" id="m-out">Sign out</button></div>`
   :`<label class="f">Your name<input type="text" id="m-name" value="${esc(S.me.name)}" placeholder="Shown on every job you log"></label>`}
  </section>
  ${isAdmin()?`<section class="section"><h2>Company</h2>
  <label class="f">Company name on reports<input type="text" id="m-co" value="${esc(st.company)}"></label>
  <div class="row"><label class="f">Job number prefix<input type="text" id="m-pre" value="${esc(st.prefix)}"></label><label class="f">Next job number<input type="number" id="m-next" value="${st.nextNo}"></label></div>
  </section>
  <section class="section"><h2>Logo on reports</h2>
  ${st.logo?`<img src="${st.logo}" alt="Company logo" style="max-height:70px;max-width:220px;background:#fff;border-radius:6px;padding:6px">`:'<p class="note" style="margin:0">No logo yet. Upload a PNG or JPG and it will appear at the top of every PDF report.</p>'}
  <div class="actions"><label class="btn file-btn">${st.logo?"Change logo":"Upload logo"}<input type="file" id="m-logo" accept="image/png,image/jpeg"></label>${st.logo?'<button class="btn" id="m-logo-rm">Remove logo</button>':""}</div></section>`:""}
  ${!CLOUD?`<div class="actions"><button class="btn primary" id="m-save">Save</button></div>`:isAdmin()?`<div class="actions"><button class="btn primary" id="m-save">Save company details</button></div>`:""}
  ${CLOUD&&isAdmin()?`<section class="section"><h2>Team</h2>
   ${pending.length?`<div class="callout">${pending.length} new account${pending.length>1?"s":""} waiting for approval.</div>`:""}
   <div class="stack" style="gap:8px">${S.team.slice().sort((a,b)=>(a.active-b.active)||a.full_name.localeCompare(b.full_name)).map(p=>`<div class="row" style="align-items:center;border-bottom:1px solid var(--line);padding-bottom:8px">
     <div style="flex:2 1 180px"><b>${esc(p.full_name||"(no name)")}</b><div class="note">${esc(p.email||"")}</div></div>
     <div style="flex:1 1 120px"><span class="pill ${p.active?(p.role==="admin"?"done":"sla"):"nonsla"}">${p.active?(p.role==="admin"?"Office":"Technician"):"Waiting"}</span></div>
     <div class="row" style="flex:2 1 220px;gap:6px">${p.id===S.user.id?'<span class="note">This is you</span>':`${p.active?`<button class="btn small" data-tm="off" data-id="${p.id}">Block</button>`:`<button class="btn small primary" data-tm="on" data-id="${p.id}">Approve</button>`}<button class="btn small" data-tm="role" data-id="${p.id}">${p.role==="admin"?"Make technician":"Make office"}</button>`}</div></div>`).join("")}</div>
   <p class="note" style="margin:0">New technicians open the app, tap “Create an account”, and appear here for you to approve.</p></section>`:""}
  ${!CLOUD?`<section class="section"><h2>Backup</h2><p class="note" style="margin:0">Jobs are saved on this phone only. Download a backup regularly, or before changing phones.</p>
  <div class="actions"><button class="btn" id="m-exp">Download backup</button><label class="btn file-btn">Restore from backup<input type="file" id="m-imp" accept=".json,application/json"></label></div></section>`:""}
  ${ex?`<section class="section"><h2>Example data</h2><p class="note" style="margin:0">The app started with ${ex} example records so you can see how it works.</p><div class="actions"><button class="btn danger" id="m-clr">Remove examples</button></div></section>`:""}
  </div>`;
  const $=id=>document.getElementById(id);const v=id=>$(id).value.trim();
  if($("m-sync"))$("m-sync").onclick=async()=>{if(needOnline())return;await syncNow();toast(S.sync.error?"Sync problem: "+S.sync.error:"Up to date")};
  if($("m-out"))$("m-out").onclick=signOut;
  if($("m-logo"))$("m-logo").onchange=async e=>{const f=e.target.files[0];if(!f)return;const im=new Image();im.onload=async()=>{const sc=Math.min(1,600/Math.max(im.width,im.height));const cv=document.createElement("canvas");cv.width=Math.round(im.width*sc);cv.height=Math.round(im.height*sc);const g=cv.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,cv.width,cv.height);g.drawImage(im,0,0,cv.width,cv.height);URL.revokeObjectURL(im.src);
      const logo={logo:cv.toDataURL("image/jpeg",.9),logoW:cv.width,logoH:cv.height};
      if(CLOUD){if(needOnline())return;const{error}=await sb.from("settings").update({logo:logo.logo,logo_w:logo.logoW,logo_h:logo.logoH,updated_at:new Date().toISOString()}).eq("id",1);if(error){toast("Couldn't save logo: "+error.message);return}}
      Object.assign(S.settings,logo);await saveSettingsLocal();toast("Logo saved");vSettings()};im.onerror=()=>toast("That file could not be read as an image");im.src=URL.createObjectURL(f)};
  if($("m-logo-rm"))$("m-logo-rm").onclick=async()=>{if(CLOUD){if(needOnline())return;await sb.from("settings").update({logo:null}).eq("id",1)}S.settings.logo=null;await saveSettingsLocal();vSettings()};
  if($("m-save"))$("m-save").onclick=async()=>{
    if(!CLOUD){S.me.name=v("m-name");await saveMe()}
    if(isAdmin()&&$("m-co")){const n={company:v("m-co")||"FFR Comms",prefix:(v("m-pre")||"FFR").replace(/\s+/g,""),nextNo:Math.max(1,parseInt(v("m-next"))||1)};
      if(CLOUD){if(needOnline())return;const{error}=await sb.from("settings").update({company:n.company,prefix:n.prefix,next_no:n.nextNo,updated_at:new Date().toISOString()}).eq("id",1);if(error){toast("Couldn't save: "+error.message);return}}
      Object.assign(S.settings,n);await saveSettingsLocal()}
    toast("Saved")};
  view.querySelectorAll("[data-tm]").forEach(b=>b.onclick=async()=>{if(needOnline())return;const p=S.team.find(x=>x.id===b.dataset.id);const ch=b.dataset.tm==="on"?{active:true}:b.dataset.tm==="off"?{active:false}:{role:p.role==="admin"?"tech":"admin"};
    if(b.dataset.tm==="off"&&!await confirmBox(`Block ${p.full_name}? They won't be able to see or log jobs until you approve them again.`,"Block"))return;
    const{error}=await sb.from("profiles").update(ch).eq("id",p.id);if(error){toast("Couldn't update: "+error.message);return}Object.assign(p,ch);vSettings()});
  if($("m-exp"))$("m-exp").onclick=()=>saveFile(`FFR field log backup ${today()}.json`,new Blob([JSON.stringify({app:"ffr-field-log",v:2,exported:new Date().toISOString(),me:S.me,settings:S.settings,clients:S.clients,jobs:S.jobs})],{type:"application/json"}));
  if($("m-imp"))$("m-imp").onchange=async e=>{const f=e.target.files[0];if(!f)return;try{const d=JSON.parse(await f.text());if(d.app!=="ffr-field-log")throw 0;
      for(const c of d.clients||[])await Store.put("clients",c);for(const j of d.jobs||[])await Store.put("jobs",j);S.clients=await Store.all("clients");S.jobs=await Store.all("jobs");
      if(d.settings){Object.assign(S.settings,d.settings);await saveSettingsLocal()}toast(`Restored ${(d.jobs||[]).length} jobs and ${(d.clients||[]).length} clients`);vSettings()}catch(err){toast("That file isn't an FFR Field Log backup")}};
  if($("m-clr"))$("m-clr").onclick=async()=>{for(const j of S.jobs.filter(j=>j.example))await Store.del("jobs",j.id);S.jobs=S.jobs.filter(j=>!j.example);
    for(const c of S.clients.filter(c=>c.example&&!S.jobs.some(j=>j.clientId===c.id)))await Store.del("clients",c.id);S.clients=S.clients.filter(c=>!c.example||S.jobs.some(j=>j.clientId===c.id));S.materials=S.materials.filter(m=>!m.example);await saveMaterialsLocal();toast("Examples removed");vSettings()};
}

/* ---------- start ---------- */
(async()=>{
  await loadLocal();
  if(!CLOUD){
    const seeded=await Store.get("meta","seeded");
    if(!seeded){await seedExamples();await Store.put("meta",{key:"seeded",value:true})}
  }else{
    const{data}=await sb.auth.getSession();S.user=data.session?.user||null;
    if(S.user&&S.profile&&S.profile.id!==S.user.id)S.profile=null;
    sb.auth.onAuthStateChange(async(ev,session)=>{
      const was=S.user?.id;S.user=session?.user||null;
      if(S.user&&S.user.id!==was){await refreshProfile();render();syncNow()}
      if(!S.user&&was){render()}
    });
    if(S.user){if(!S.profile)await refreshProfile();syncNow()}
  }
  renderWho();render();
  if("serviceWorker"in navigator&&location.protocol==="https:")navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
