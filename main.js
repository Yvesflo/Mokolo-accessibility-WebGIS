// ═══════════════════════════════════════════════════════════════════════
// Mokolo Health District — Accessibility & Coverage Map
// Stack: MapLibre GL JS 5 · PMTiles · georaster · proj4 · jsPDF · Vite
// ═══════════════════════════════════════════════════════════════════════
import maplibregl     from 'maplibre-gl';
import { Protocol }  from 'pmtiles';
import parseGeoraster from 'georaster';
import proj4          from 'proj4';
import { jsPDF }      from 'jspdf';

// ── PMTiles protocol ──────────────────────────────────────────────────
const pmtilesProtocol = new Protocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile.bind(pmtilesProtocol));

// ── proj4: UTM defs for Cameroon ──────────────────────────────────────
proj4.defs('EPSG:32632','+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs');
proj4.defs('EPSG:32633','+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs');
proj4.defs('EPSG:32634','+proj=utm +zone=34 +datum=WGS84 +units=m +no_defs');

// ── Map ───────────────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container : 'map',
  style     : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center    : [13.81, 10.74],
  zoom      : 9,
  minZoom   : 6,
  maxZoom   : 19,
  preserveDrawingBuffer: true,               // needed for canvas.toDataURL()
  customAttribution: '© MINSANTE/DOST : Yves Wasnyo 2026 | Hydrosheds, Copernicus, OSM, Sentinel 2, GHSL, WOF',
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl(), 'top-left');
map.addControl(new maplibregl.FullscreenControl(), 'top-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// ── Health-facility categories ────────────────────────────────────────
const CATS = {
  'HR/HRA': { color:'#d62728', radius:14, beds:1000, fr:'Hopital Regional / HRA' },
  'HD'    : { color:'#ff7f0e', radius:11, beds: 300, fr:'Hopital de District'     },
  'CMA'   : { color:'#2ca02c', radius: 9, beds: 100, fr:"Centre Medical d'Arr."   },
  'CSI'   : { color:'#1f77b4', radius: 7, beds:  50, fr:'Centre de Sante Integre' },
};
const CAT_OTHER = '#9467bd';

// ── Route category code → name (cap code ≥ 5 → CSI) ─────────────────
const CAT_CODE_MAP = { 1:'HG', 2:'HR/HRA', 3:'HD', 4:'CMA', 5:'CSI' };
function catCodeName(code) {
  const c = Math.min(+code, 5);
  return CAT_CODE_MAP[c] || 'Inconnu';
}

// ── MapLibre match expr: cat_name → color ─────────────────────────────
const catColorExpr = [
  'match', ['get','cat_name'],
  'HR/HRA','#d62728','HD','#ff7f0e','CMA','#2ca02c','CSI','#1f77b4',
  CAT_OTHER,
];

// ── Referral route time → color & width ──────────────────────────────
// Line color stepped on 'm' (time in minutes)
const refTimeColorExpr = [
  'step', ['get','m'],
  '#27ae60',          // 0 – 30 min  (green)
  30,  '#f39c12',     // 30 – 60 min (amber)
  60,  '#e67e22',     // 60 – 120 min(orange)
  120, '#e74c3c',     // > 120 min   (red)
];
// Line width interpolated on 'km' (distance)
const refWidthExpr = [
  'interpolate',['linear'],['get','km'],
  0, 2,   50, 4,   120, 6,
];

// ── Colormap stops  [value, [R,G,B,A]] ────────────────────────────────
const STOPS_ACCESS = [
  [  0, [  0,160,  0,230]],
  [ 15, [ 80,210, 50,215]],
  [ 30, [230,220, 10,210]],
  [ 60, [255,140,  0,210]],
  [120, [220, 30, 10,210]],
  [240, [100,  0, 30,215]],
];
const STOPS_RESID = [
  [  0, [  0,  0,  0,  0]],
  [  1, [255,255,200,160]],
  [ 30, [255,210, 30,195]],
  [100, [255,100,  0,205]],
  [300, [200, 10, 10,210]],
  [700, [ 70,  0, 50,220]],
];
// Population density — viridis-inspired: transparent→dark-purple→blue→cyan→green→yellow
const STOPS_POP = [
  [   0, [  0,  0,  0,  0]],
  [   1, [ 68,  1, 84,180]],
  [  10, [ 59, 82,139,195]],
  [  50, [ 33,145,140,205]],
  [ 200, [ 94,201,  97,210]],
  [ 500, [253,231, 37,215]],
  [1000, [255,255,255,220]],
];

// ── Raster filter state (min/max value range to display) ─────────────
const rasterFilter = {
  access  : { min: 0, max: 240 },
  residual: { min: 0, max: 700 },
  population: { min: 0, max: 1000 },
};

// ── Color interpolation + filter ──────────────────────────────────────
function interpStops(v, stops) {
  if (v == null || isNaN(v))                return [0,0,0,0];
  if (v <= stops[0][0])                     return [...stops[0][1]];
  if (v >= stops[stops.length-1][0])        return [...stops[stops.length-1][1]];
  for (let i=0;i<stops.length-1;i++) {
    const [v0,c0]=stops[i],[v1,c1]=stops[i+1];
    if (v>=v0 && v<=v1) {
      const t=(v-v0)/(v1-v0);
      return c0.map((c,j)=>Math.round(c+t*(c1[j]-c)));
    }
  }
  return [0,0,0,0];
}
const accessColor = v => {
  if (v==null||isNaN(v)) return [0,0,0,0];
  const f=rasterFilter.access;
  if (v<f.min||v>f.max)  return [0,0,0,0];
  return interpStops(v,STOPS_ACCESS);
};
const residColor = v => {
  if (v==null||isNaN(v)) return [0,0,0,0];
  const f=rasterFilter.residual;
  if (v<f.min||v>f.max)  return [0,0,0,0];
  return interpStops(v,STOPS_RESID);
};
const popColor = v => {
  if (v==null||isNaN(v)||v<=0) return [0,0,0,0];
  const f=rasterFilter.population;
  if (v<f.min||v>f.max)        return [0,0,0,0];
  return interpStops(v,STOPS_POP);
};

// ── Tile index → WGS-84 bbox ──────────────────────────────────────────
function tileBBox(z,x,y) {
  const n=Math.pow(2,z);
  return {
    w:(x/n)*360-180, e:((x+1)/n)*360-180,
    n:(Math.atan(Math.sinh(Math.PI*(1-2*y/n)))*180)/Math.PI,
    s:(Math.atan(Math.sinh(Math.PI*(1-2*(y+1)/n)))*180)/Math.PI,
  };
}

// ── Sample georaster at lon/lat ────────────────────────────────────────
function sampleRaster(raster,lon,lat) {
  let sx=lon,sy=lat;
  if (raster.projection!==4326) {
    try { [sx,sy]=proj4(proj4.WGS84,'EPSG:'+raster.projection,[lon,lat]); }
    catch { return null; }
  }
  const {xmin,ymax,pixelWidth,pixelHeight,values,noDataValue,width,height}=raster;
  const col=Math.floor((sx-xmin)/pixelWidth);
  const row=Math.floor((ymax-sy)/pixelHeight);
  if (col<0||col>=width||row<0||row>=height) return null;
  const v=values[0][row][col];
  if (noDataValue!==undefined&&(v===noDataValue||isNaN(v))) return null;
  return v;
}

// ── Render a 256×256 tile → PNG ArrayBuffer ───────────────────────────
function renderTile(raster,colorFn,z,x,y) {
  const SZ=256, bb=tileBBox(z,x,y);
  const cv=Object.assign(document.createElement('canvas'),{width:SZ,height:SZ});
  const ctx=cv.getContext('2d');
  const img=ctx.createImageData(SZ,SZ);
  for (let py=0;py<SZ;py++) {
    const lat=bb.n-(py/SZ)*(bb.n-bb.s);
    for (let px=0;px<SZ;px++) {
      const lon=bb.w+(px/SZ)*(bb.e-bb.w);
      const [r,g,b,a]=colorFn(sampleRaster(raster,lon,lat));
      const i=(py*SZ+px)*4;
      img.data[i]=r;img.data[i+1]=g;img.data[i+2]=b;img.data[i+3]=a;
    }
  }
  ctx.putImageData(img,0,0);
  return new Promise((res,rej)=>
    cv.toBlob(async blob=>{
      if (!blob) return rej(new Error('toBlob failed'));
      res({data:await blob.arrayBuffer()});
    },'image/png')
  );
}

// ── Register a georaster as a MapLibre custom protocol ────────────────
function registerRasterProtocol(name,raster,colorFn) {
  maplibregl.addProtocol(name,(params)=>{
    const path=params.url.replace(name+'://','').split('?')[0];
    const [z,x,y]=path.split('/').map(Number);
    return renderTile(raster,colorFn,z,x,y);
  });
}

// ── Force-refresh raster tiles by cache-busting the tile URL ──────────
function refreshRasterTiles(sourceId, protocolName) {
  const src=map.getSource(sourceId);
  if (!src) return;
  src.setTiles([protocolName+'://{z}/{x}/{y}?v='+Date.now()]);
}

// ── GeoJSON feature → [[minLon,minLat],[maxLon,maxLat]] ───────────────
function featureBBox(feat) {
  let mnX=Infinity,mnY=Infinity,mxX=-Infinity,mxY=-Infinity;
  const run=pts=>pts.forEach(([x,y])=>{
    if(x<mnX)mnX=x;if(x>mxX)mxX=x;if(y<mnY)mnY=y;if(y>mxY)mxY=y;
  });
  const{type,coordinates:c}=feat.geometry;
  if(type==='Polygon')      c.forEach(run);
  if(type==='MultiPolygon') c.forEach(p=>p.forEach(run));
  return [[mnX,mnY],[mxX,mxY]];
}

// ═══════════════════════════════════════════════════════════════════════
// MAP LOAD
// ═══════════════════════════════════════════════════════════════════════
map.on('load', async () => {

  // ── A. Fetch all GeoJSON ────────────────────────────────────────────
  async function fetchJSON(url) {
    const r=await fetch(url);
    if (!r.ok) throw new Error('HTTP '+r.status+' : '+url);
    return r.json();
  }
  const [district,aires,coverage,refCsiCma,refCmaHd,facilities]=await Promise.all([
    fetchJSON('./data/district_boundary.geojson'),
    fetchJSON('./data/aires_de_sante.geojson'),
    fetchJSON('./data/coverage_zones.geojson'),
    fetchJSON('./data/referral_routes_csi_cma.geojson'),
    fetchJSON('./data/referral_routes_cma_hd.geojson'),
    fetchJSON('./data/health_facilities.geojson'),
  ]);
  let settlements=null;
  try { settlements=await fetchJSON('./data/Settlements_Mokolo.geojson'); }
  catch { console.info('[settlements] File not found — layer skipped.'); }

  // ── B. Sources ──────────────────────────────────────────────────────
  map.addSource('district',    {type:'geojson',data:district});
  map.addSource('aires',       {type:'geojson',data:aires});
  map.addSource('coverage',    {type:'geojson',data:coverage});
  map.addSource('ref-csi-cma', {type:'geojson',data:refCsiCma});
  map.addSource('ref-cma-hd',  {type:'geojson',data:refCmaHd});
  map.addSource('facilities',  {type:'geojson',data:facilities});
  // Settlements: no clustering — show every individual point
  if (settlements) {
    map.addSource('settlements',{type:'geojson',data:settlements});
  }

  // ── C. Layers (back → front) ────────────────────────────────────────

  // 1 District fill
  map.addLayer({id:'district-fill',type:'fill',source:'district',
    paint:{'fill-color':'#d6eaf8','fill-opacity':0.18}});

  // 2 Aires fill (22 pastel colours cycled by admin_code)
  const AIRE_PAL=[
    '#fde8e8','#fdefd8','#fdf8d8','#e8fde8','#d8f5fd','#d8e8fd',
    '#ead8fd','#fdd8f5','#fde8d8','#e8f5d8','#d8fdf0','#d8f0fd',
    '#ddd8fd','#fdd8e8','#f5fdd8','#d8fddd','#fdfdd8','#fdd8fd',
    '#d8fdfd','#f5d8fd','#d8fdf5','#e8d8fd',
  ];
  const AIRE_MATCH=[
    'match',['to-number',['get','admin_code']],
    ...AIRE_PAL.flatMap((col,i)=>[i+1,col]),
    '#f0f4f8',
  ];
  map.addLayer({id:'aires-fill',type:'fill',source:'aires',
    paint:{'fill-color':AIRE_MATCH,'fill-opacity':0}});

  // 3 Aires outline
  map.addLayer({id:'aires-outline',type:'line',source:'aires',
    paint:{'line-color':'#777777','line-width':0.8,'line-dasharray':[4,3]}});

  // 4 Coverage fill
  map.addLayer({id:'coverage-fill',type:'fill',source:'coverage',
    paint:{'fill-color':catColorExpr,'fill-opacity':0.16}});

  // 5 Coverage outline
  map.addLayer({id:'coverage-outline',type:'line',source:'coverage',
    paint:{'line-color':catColorExpr,'line-width':1.5,'line-opacity':0.65}});

  // 6 CSI→CMA referral lines — colored by time, width by distance
  map.addLayer({id:'ref-csi-cma-line',type:'line',source:'ref-csi-cma',
    paint:{
      'line-color':refTimeColorExpr,
      'line-width':refWidthExpr,
      'line-dasharray':[5,3],
    }});

  // 7 CSI→CMA direction arrows
  map.addLayer({id:'ref-csi-cma-arrow',type:'symbol',source:'ref-csi-cma',
    layout:{
      'symbol-placement':'line','text-field':'>',
      'text-font':['Arial Unicode MS Regular'],
      'text-size':13,'text-keep-upright':false,'symbol-spacing':65,
    },
    paint:{'text-color':refTimeColorExpr,'text-halo-color':'#fff','text-halo-width':1}});

  // 8 CMA→HD/HR referral lines — colored by time, width by distance
  map.addLayer({id:'ref-cma-hd-line',type:'line',source:'ref-cma-hd',
    paint:{
      'line-color':refTimeColorExpr,
      'line-width':refWidthExpr,
    }});

  // 9 CMA→HD/HR direction arrows
  map.addLayer({id:'ref-cma-hd-arrow',type:'symbol',source:'ref-cma-hd',
    layout:{
      'symbol-placement':'line','text-field':'>',
      'text-font':['Arial Unicode MS Regular'],
      'text-size':15,'text-keep-upright':false,'symbol-spacing':85,
    },
    paint:{'text-color':refTimeColorExpr,'text-halo-color':'#fff','text-halo-width':1.5}});

  // 10 Settlements — ALL individual points at every zoom
  if (settlements) {
    map.addLayer({id:'sett-point',type:'circle',source:'settlements',
      paint:{
        'circle-radius':['interpolate',['linear'],['zoom'],6,2,10,3,14,5],
        'circle-color':'#8e44ad',
        'circle-stroke-width':['interpolate',['linear'],['zoom'],6,0.5,12,1.5],
        'circle-stroke-color':'#ffffff',
        'circle-opacity':0.85,
      }});
    map.addLayer({id:'sett-label',type:'symbol',source:'settlements',
      minzoom:11,
      layout:{
        'text-field':['get','name'],
        'text-size':9.5,'text-offset':[0,1.1],'text-anchor':'top',
        'text-font':['Arial Unicode MS Regular'],
        'text-max-width':8,
      },
      paint:{'text-color':'#5a3e6b','text-halo-color':'rgba(255,255,255,0.85)','text-halo-width':1.2}});
  }

  // 11 Facilities
  map.addLayer({id:'facilities-circle',type:'circle',source:'facilities',
    paint:{
      'circle-radius':['match',['get','cat_name'],'HR/HRA',14,'HD',11,'CMA',9,'CSI',7,5],
      'circle-color':catColorExpr,
      'circle-stroke-width':2,'circle-stroke-color':'#ffffff','circle-opacity':0.92,
    }});

  // 12 Facility labels (zoom ≥ 11)
  map.addLayer({id:'facilities-label',type:'symbol',source:'facilities',
    minzoom:11,
    layout:{
      'text-field':['get','Aire'],
      'text-size':10.5,'text-offset':[0,1.3],'text-anchor':'top',
      'text-max-width':10,'text-font':['Arial Unicode MS Regular'],
    },
    paint:{'text-color':'#1a1a2e','text-halo-color':'rgba(255,255,255,0.8)','text-halo-width':1.5}});

  // 13 Aire labels (zoom ≥ 9)
  map.addLayer({id:'aires-label',type:'symbol',source:'aires',
    minzoom:9,
    layout:{
      'text-field':['get','admin_name'],
      'text-size':11,'text-anchor':'center','text-max-width':8,
      'text-font':['Arial Unicode MS Regular'],
    },
    paint:{'text-color':'#333333','text-halo-color':'rgba(255,255,255,0.8)','text-halo-width':1.5}});

  // 14 District outline (topmost)
  map.addLayer({id:'district-outline',type:'line',source:'district',
    paint:{'line-color':'#0f3460','line-width':2.5}});

  // ── D. Layer toggles ────────────────────────────────────────────────
  const TOGGLE_MAP={
    'toggle-accessibility' :['accessibility-raster'],
    'toggle-residual'      :['residual-raster'],
    'toggle-population'    :['population-raster'],
    'toggle-coverage'      :['coverage-fill','coverage-outline'],
    'toggle-ref-csi'       :['ref-csi-cma-line','ref-csi-cma-arrow'],
    'toggle-ref-cma'       :['ref-cma-hd-line','ref-cma-hd-arrow'],
    'toggle-facilities'    :['facilities-circle','facilities-label'],
    'toggle-settlements'   :['sett-point','sett-label'],
    'toggle-aires'         :['aires-fill','aires-outline','aires-label'],
    'toggle-district'      :['district-fill','district-outline'],
  };
  for (const [cbId,layerIds] of Object.entries(TOGGLE_MAP)) {
    const cb=document.getElementById(cbId);
    if (!cb) continue;
    if (cbId==='toggle-accessibility'||cbId==='toggle-residual'||cbId==='toggle-population') cb.checked=false;
    cb.addEventListener('change',()=>{
      const vis=cb.checked?'visible':'none';
      layerIds.forEach(id=>{ if(map.getLayer(id)) map.setLayoutProperty(id,'visibility',vis); });
    });
  }

  // ── E. Opacity sliders ──────────────────────────────────────────────
  function bindOpacity(sliderId,valId,layerId) {
    const el=document.getElementById(sliderId),lbl=document.getElementById(valId);
    if (!el) return;
    el.addEventListener('input',()=>{
      const pct=+el.value;
      if (lbl) lbl.textContent=pct+'%';
      if (map.getLayer(layerId)) map.setPaintProperty(layerId,'raster-opacity',pct/100);
    });
  }
  bindOpacity('opacity-accessibility','opacity-val-accessibility','accessibility-raster');
  bindOpacity('opacity-residual','opacity-val-residual','residual-raster');
  bindOpacity('opacity-population','opacity-val-population','population-raster');

  // ── F. Raster range-filter sliders ──────────────────────────────────
  function bindRasterFilter(minId,maxId,fminId,fmaxId,key,srcId,proto) {
    const minEl=document.getElementById(minId),maxEl=document.getElementById(maxId);
    const minLbl=document.getElementById(fminId),maxLbl=document.getElementById(fmaxId);
    if (!minEl||!maxEl) return;
    function update() {
      let mn=+minEl.value,mx=+maxEl.value;
      if (mn>mx) { mn=mx; minEl.value=mn; }
      rasterFilter[key].min=mn; rasterFilter[key].max=mx;
      if (minLbl) minLbl.textContent=mn;
      if (maxLbl) maxLbl.textContent=mx;
      refreshRasterTiles(srcId,proto);
    }
    minEl.addEventListener('input',update);
    maxEl.addEventListener('input',update);
  }
  bindRasterFilter('filter-access-min','filter-access-max',
    'fval-access-min','fval-access-max','access','raster-access','accessibility');
  bindRasterFilter('filter-resid-min','filter-resid-max',
    'fval-resid-min','fval-resid-max','residual','raster-residual','residual');
  bindRasterFilter('filter-pop-min','filter-pop-max',
    'fval-pop-min','fval-pop-max','population','raster-population','population');

  // ── G. Search — aire de sante ───────────────────────────────────────
  const searchInput  = document.getElementById('search-aire');
  const resultsList  = document.getElementById('search-results');
  const clearBtn     = document.getElementById('search-clear');
  const filterBadge  = document.getElementById('aire-filter-badge');
  const filterLabel  = document.getElementById('aire-filter-label');
  const filterClear  = document.getElementById('aire-filter-clear');
  const AIRE_INDEX   = aires.features.map(f=>({name:f.properties.admin_name,feat:f}));

  searchInput.addEventListener('input',()=>{
    const q=searchInput.value.trim().toLowerCase();
    resultsList.innerHTML='';
    if (!q) return;
    AIRE_INDEX.filter(o=>o.name.toLowerCase().includes(q)).slice(0,9).forEach(o=>{
      const li=document.createElement('li');
      li.textContent=o.name;
      li.addEventListener('click',()=>{
        searchInput.value=o.name; resultsList.innerHTML='';
        map.fitBounds(featureBBox(o.feat),{padding:60,duration:900,maxZoom:13});
        highlightAire(o.feat);
      });
      resultsList.appendChild(li);
    });
  });

  if (clearBtn)    clearBtn.addEventListener('click', resetAireSelection);
  if (filterClear) filterClear.addEventListener('click', resetAireSelection);

  /** Reset search input + remove all filters */
  function resetAireSelection() {
    searchInput.value='';
    resultsList.innerHTML='';
    removeHighlight();
  }

  /**
   * Highlight the selected aire AND spatially filter every other layer
   * so only features inside/related to that aire are visible.
   */
  function highlightAire(feat) {
    removeHighlight();

    // 1. Highlight outline
    map.addSource('hl',{type:'geojson',data:feat});
    map.addLayer({id:'hl',type:'line',source:'hl',
      paint:{'line-color':'#e94560','line-width':3,'line-dasharray':[3,2]}});

    const aireName = feat.properties.admin_name || feat.properties.Name || '';

    // 2. Zoom to the selected aire (all other layers stay fully visible)
    const coords = feat.geometry.type === 'MultiPolygon'
      ? feat.geometry.coordinates.flat(2)
      : feat.geometry.coordinates.flat(1);
    const lngs = coords.map(c => c[0]);
    const lats = coords.map(c => c[1]);
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { padding: 60, duration: 800 }
    );

    // 3. Show badge
    if (filterBadge && filterLabel) {
      filterLabel.textContent = aireName;
      filterBadge.style.display = 'flex';
    }
  }

  /** Remove highlight outline and hide badge */
  function removeHighlight() {
    if (map.getLayer('hl'))  map.removeLayer('hl');
    if (map.getSource('hl')) map.removeSource('hl');
    if (filterBadge) filterBadge.style.display = 'none';
  }

  // ── H. Click / info handlers ────────────────────────────────────────
  const infoBox  =document.getElementById('info-box');
  const infoBody =document.getElementById('info-content');
  const showInfo =html=>{ infoBox.style.display='block'; infoBody.innerHTML=html; };
  const row      =(lbl,val)=>
    '<div class="info-row"><span class="info-label">'+lbl+'</span>'+
    '<span class="info-val">'+val+'</span></div>';

  // Facilities
  map.on('click','facilities-circle',e=>{
    const p=e.features[0].properties;
    const cat=CATS[p.cat_name]||{};
    showInfo(
      '<strong>'+(p.Aire||p.cat_name)+'</strong>'+
      row('Catégorie',p.cat_name||'—')+
      (cat.beds?row('Capacité',cat.beds+' lits'):'')+
      row('Statut',p.statut||'—')+
      row('District',p.District||'—')+
      '<div style="margin-top:5px;font-size:10px;color:#6e7681">'+
        'Lat '+parseFloat(p.Latitude).toFixed(5)+'  Lon '+parseFloat(p.Longitude).toFixed(5)+'</div>'
    );
  });

  // Coverage zones
  map.on('click','coverage-fill',e=>{
    const p=e.features[0].properties;
    const beds={'HR/HRA':1000,'HD':300,'CMA':100,'CSI':50}[p.cat_name]||'—';
    showInfo('<strong>Zone de couverture</strong>'+
      row('Catégorie',p.cat_name||'—')+
      row('Capacité',beds+(beds!=='—'?' lits':''))+
      row('ID FS',p.ID||'—'));
  });

  // Referral CSI→CMA
  map.on('click','ref-csi-cma-line',e=>{
    const p=e.features[0].properties;
    const fromName=catCodeName(p.from__cat);
    const toName  =catCodeName(p.to__cat);
    showInfo(
      '<strong>Référence : '+fromName+' → '+toName+'</strong>'+
      row('De (cat)',fromName+' (code '+Math.min(+p.from__cat,5)+')')+
      row('Vers (cat)',toName+' (code '+Math.min(+p.to__cat,5)+')')+
      row('Distance',p.km+' km')+
      row('Temps de trajet',p.m+' min'));
  });

  // Referral CMA→HD/HR
  map.on('click','ref-cma-hd-line',e=>{
    const p=e.features[0].properties;
    const fromName=catCodeName(p.from__cat);
    const toName  =catCodeName(p.to__cat);
    showInfo(
      '<strong>Référence : '+fromName+' → '+toName+'</strong>'+
      row('De (cat)',fromName+' (code '+Math.min(+p.from__cat,5)+')')+
      row('Vers (cat)',toName+' (code '+Math.min(+p.to__cat,5)+')')+
      row('Distance',p.km+' km')+
      row('Temps de trajet',p.m+' min'));
  });

  // Aires de sante
  map.on('click','aires-fill',e=>{
    const p=e.features[0].properties;
    showInfo('<strong>Aire de Santé</strong>'+
      row('Nom',p.admin_name||'—')+
      row('Code',p.Code_AS||'—')+
      row('District',p.District_S||'—'));
  });

  // Pointer cursors
  ['facilities-circle','coverage-fill','ref-csi-cma-line','ref-cma-hd-line','aires-fill',
   'sett-point'].forEach(id=>{
    map.on('mouseenter',id,()=>{ map.getCanvas().style.cursor='pointer'; });
    map.on('mouseleave',id,()=>{ map.getCanvas().style.cursor=''; });
  });

  // ── I. Build legend & start raster loading ──────────────────────────
  buildLegends();
  loadRasters();

}); // end map.on('load')

// ═══════════════════════════════════════════════════════════════════════
// ASYNC RASTER LOADING
// ═══════════════════════════════════════════════════════════════════════
async function loadRasters() {
  const badge=document.getElementById('raster-loading');
  /** sync layer visibility to current checkbox state */
  function syncToggle(layerId, cbId) {
    const cb = document.getElementById(cbId);
    const vis = (cb && cb.checked) ? 'visible' : 'none';
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', vis);
  }
  async function fetchRaster(url) {
    const r=await fetch(url);
    if (!r.ok) throw new Error('HTTP '+r.status+' '+url);
    return parseGeoraster(await r.arrayBuffer());
  }
  try {
    if (badge) { badge.style.display='block'; badge.textContent='⏳ Chargement rasters…'; }
    const [accR,resR,popR]=await Promise.all([
      fetchRaster('./data/Accessibility_PHF.tif'),
      fetchRaster('./data/Coverage_PHF.tif'),
      fetchRaster('./data/Population.tif'),
    ]);
    window._rasterStats={
      access    :{min:accR.mins[0],max:accR.maxs[0]},
      residual  :{min:resR.mins[0],max:resR.maxs[0]},
      population:{min:popR.mins[0],max:popR.maxs[0]},
    };
    // Sync filter sliders to actual raster max
    const accMax=Math.ceil(accR.maxs[0]);
    const resMax=Math.ceil(resR.maxs[0]);
    const popMax=Math.ceil(popR.maxs[0]);
    ['filter-access-max','filter-access-min'].forEach(id=>{
      const el=document.getElementById(id);
      if (el) { el.max=accMax; if (id.endsWith('max')) el.value=accMax; }
    });
    ['filter-resid-max','filter-resid-min'].forEach(id=>{
      const el=document.getElementById(id);
      if (el) { el.max=resMax; if (id.endsWith('max')) el.value=resMax; }
    });
    ['filter-pop-max','filter-pop-min'].forEach(id=>{
      const el=document.getElementById(id);
      if (el) { el.max=popMax; if (id.endsWith('max')) el.value=popMax; }
    });
    const fam=document.getElementById('fval-access-max'); if (fam) fam.textContent=accMax;
    const frm=document.getElementById('fval-resid-max');  if (frm) frm.textContent=resMax;
    const fpm=document.getElementById('fval-pop-max');    if (fpm) fpm.textContent=popMax;
    rasterFilter.access.max=accMax; rasterFilter.residual.max=resMax; rasterFilter.population.max=popMax;

    registerRasterProtocol('accessibility',accR,accessColor);
    registerRasterProtocol('residual',     resR,residColor);
    registerRasterProtocol('population',   popR,popColor);

    map.addSource('raster-access',{
      type:'raster',tiles:['accessibility://{z}/{x}/{y}'],
      tileSize:256,minzoom:6,maxzoom:14,
    });
    map.addSource('raster-residual',{
      type:'raster',tiles:['residual://{z}/{x}/{y}'],
      tileSize:256,minzoom:6,maxzoom:14,
    });
    map.addSource('raster-population',{
      type:'raster',tiles:['population://{z}/{x}/{y}'],
      tileSize:256,minzoom:6,maxzoom:14,
    });
    map.addLayer({id:'accessibility-raster',type:'raster',
      source:'raster-access',
      paint:{'raster-opacity':0.75},layout:{visibility:'none'}
    },'aires-fill');
    syncToggle('accessibility-raster','toggle-accessibility');

    map.addLayer({id:'residual-raster',type:'raster',
      source:'raster-residual',
      paint:{'raster-opacity':0.75},layout:{visibility:'none'}
    },'aires-fill');
    syncToggle('residual-raster','toggle-residual');

    map.addLayer({id:'population-raster',type:'raster',
      source:'raster-population',
      paint:{'raster-opacity':0.75},layout:{visibility:'none'}
    },'accessibility-raster');
    syncToggle('population-raster','toggle-population');

    // Sync initial opacity slider values to layers
    ['accessibility','residual','population'].forEach(key=>{
      const sl=document.getElementById('opacity-'+key);
      const layerId={'accessibility':'accessibility-raster','residual':'residual-raster','population':'population-raster'}[key];
      if (sl && map.getLayer(layerId)) map.setPaintProperty(layerId,'raster-opacity',+sl.value/100);
    });

    if (badge) {
      badge.textContent='✓ Rasters chargés';
      setTimeout(()=>{ if (badge) badge.style.display='none'; },3000);
    }
    updateRasterLegend();
  } catch(err) {
    console.error('[Raster]',err);
    if (badge) { badge.style.display='block'; badge.textContent='⚠ Rasters indisponibles'; badge.style.color='#f85149'; }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// LEGEND — Clickable & filterable
// ═══════════════════════════════════════════════════════════════════════

// ── State: which facility / coverage categories are active ────────────
const activeFacCats  =new Set(Object.keys(CATS).concat(['Autre']));
const activeCovCats  =new Set(Object.keys(CATS));
// Referral time class filter state
const activeRefTime  =new Set(['t30','t60','t120','tInf']); // all active
// Ref time class → range { min, max } (max=Infinity means open)
const REF_TIME_CLASSES={
  t30 :{label:'≤ 30 min',  color:'#27ae60',min:0,   max:30 },
  t60 :{label:'31–60 min', color:'#f39c12',min:30,  max:60 },
  t120:{label:'61–120 min',color:'#e67e22',min:60,  max:120},
  tInf:{label:'> 120 min', color:'#e74c3c',min:120, max:Infinity},
};

function applyFacFilter() {
  const cats=[...activeFacCats].filter(c=>c!=='Autre');
  const hasOther=activeFacCats.has('Autre');
  // MapLibre filter: show if cat_name is in active list OR (hasOther AND not in CATS keys)
  let filt;
  if (activeFacCats.size===0) {
    filt=['==',1,0]; // hide all
  } else if (activeFacCats.size===Object.keys(CATS).length+1) {
    filt=null; // all active, remove filter
  } else {
    const conditions=[];
    if (cats.length)  conditions.push(['in',['get','cat_name'],['literal',cats]]);
    if (hasOther)     conditions.push(['!',['in',['get','cat_name'],['literal',Object.keys(CATS)]]]);
    filt=conditions.length===1?conditions[0]:['any',...conditions];
  }
  ['facilities-circle','facilities-label'].forEach(id=>{
    if (!map.getLayer(id)) return;
    if (filt) map.setFilter(id,filt); else map.setFilter(id,null);
  });
}

function applyCovFilter() {
  const cats=[...activeCovCats];
  let filt=null;
  if (cats.length===0) filt=['==',1,0];
  else if (cats.length<Object.keys(CATS).length)
    filt=['in',['get','cat_name'],['literal',cats]];
  ['coverage-fill','coverage-outline'].forEach(id=>{
    if (!map.getLayer(id)) return;
    if (filt) map.setFilter(id,filt); else map.setFilter(id,null);
  });
}

function applyRefTimeFilter() {
  if (activeRefTime.size===4||activeRefTime.size===0) {
    // all or none — let toggle handle none
    ['ref-csi-cma-line','ref-csi-cma-arrow','ref-cma-hd-line','ref-cma-hd-arrow']
      .forEach(id=>{ if(map.getLayer(id)) map.setFilter(id,activeRefTime.size?null:['==',1,0]); });
    return;
  }
  const conditions=[];
  if (activeRefTime.has('t30'))  conditions.push(['<=',['get','m'],30]);
  if (activeRefTime.has('t60'))  conditions.push(['all',['>' ,['get','m'],30],['<=',['get','m'],60]]);
  if (activeRefTime.has('t120')) conditions.push(['all',['>' ,['get','m'],60],['<=',['get','m'],120]]);
  if (activeRefTime.has('tInf')) conditions.push(['>',['get','m'],120]);
  const filt=conditions.length===1?conditions[0]:['any',...conditions];
  ['ref-csi-cma-line','ref-csi-cma-arrow','ref-cma-hd-line','ref-cma-hd-arrow'].forEach(id=>{
    if (map.getLayer(id)) map.setFilter(id,filt);
  });
}

// ── buildColorRamp (for panel legend) ─────────────────────────────────
function buildColorRamp(stops) {
  const c=Object.assign(document.createElement('canvas'),{width:200,height:14});
  c.className='legend-ramp-canvas';
  const ctx=c.getContext('2d');
  const g=ctx.createLinearGradient(0,0,200,0);
  const vMin=stops[0][0],vMax=stops[stops.length-1][0];
  stops.forEach(([v,[r,gl,b,a]])=>
    g.addColorStop((v-vMin)/(vMax-vMin),
      'rgba('+r+','+gl+','+b+','+(a/255).toFixed(2)+')')
  );
  ctx.fillStyle=g;ctx.fillRect(0,0,200,14);
  return c;
}

// ── buildLegends — main legend builder ────────────────────────────────
function buildLegends() {
  const el=document.getElementById('legend-content');
  if (!el) return;
  el.innerHTML='';

  // Helper: create a section wrapper
  function section(title) {
    const d=document.createElement('div');
    d.className='legend-block';
    const t=document.createElement('div');
    t.className='legend-block-title';
    t.textContent=title;
    d.appendChild(t);
    return d;
  }

  // ── Raster ramps (display only, not clickable) ──
  const accBk=section('Accessibilité (min de trajet)');
  accBk.appendChild(buildColorRamp(STOPS_ACCESS));
  const accLbls=document.createElement('div');
  accLbls.className='legend-ramp-labels';accLbls.id='lbl-access';
  accLbls.innerHTML='<span>0 min</span><span>—</span><span>240 min</span>';
  accBk.appendChild(accLbls);
  el.appendChild(accBk);

  const resBk=section('Population résiduelle non couverte');
  resBk.appendChild(buildColorRamp(STOPS_RESID));
  const resLbls=document.createElement('div');
  resLbls.className='legend-ramp-labels';resLbls.id='lbl-residual';
  resLbls.innerHTML='<span>0</span><span>—</span><span>max</span>';
  resBk.appendChild(resLbls);
  el.appendChild(resBk);

  const popBk=section('Densité de population (hab/km²)');
  popBk.appendChild(buildColorRamp(STOPS_POP));
  const popLbls=document.createElement('div');
  popLbls.className='legend-ramp-labels';popLbls.id='lbl-population';
  popLbls.innerHTML='<span>0</span><span>—</span><span>max</span>';
  popBk.appendChild(popLbls);
  el.appendChild(popBk);

  // ── Facilities — clickable by category ──
  const facBk=section('Établissements de santé');
  const allFacEntries=[...Object.entries(CATS),['Autre',{color:CAT_OTHER,beds:'—',fr:'Autre établissement'}]];
  allFacEntries.forEach(([k,v])=>{
    const row=document.createElement('div');
    row.className='legend-row active';
    row.dataset.cat=k;
    row.innerHTML=
      '<span class="legend-dot" style="background:'+v.color+'"></span>'+
      '<span>'+k+(v.fr?' — '+v.fr:'')+
        (v.beds&&v.beds!=='—'?' <em style="color:#6e7681">('+v.beds+' lits)</em>':'')+'</span>';
    row.addEventListener('click',()=>{
      if (activeFacCats.has(k)) {
        activeFacCats.delete(k);
        row.classList.remove('active');row.classList.add('muted');
      } else {
        activeFacCats.add(k);
        row.classList.add('active');row.classList.remove('muted');
      }
      applyFacFilter();
    });
    facBk.appendChild(row);
  });
  el.appendChild(facBk);

  // ── Coverage zones — clickable by category ──
  const covBk=section('Zones de couverture hospitalière');
  Object.entries(CATS).forEach(([k,v])=>{
    const row=document.createElement('div');
    row.className='legend-row active';
    row.dataset.cat=k;
    row.innerHTML=
      '<span class="legend-fill" style="background:'+v.color+'"></span>'+
      '<span>Zone '+k+' — '+v.beds+' lits</span>';
    row.addEventListener('click',()=>{
      if (activeCovCats.has(k)) {
        activeCovCats.delete(k);
        row.classList.remove('active');row.classList.add('muted');
      } else {
        activeCovCats.add(k);
        row.classList.add('active');row.classList.remove('muted');
      }
      applyCovFilter();
    });
    covBk.appendChild(row);
  });
  el.appendChild(covBk);

  // ── Referral routes — clickable by time class ──
  const refBk=section('Routes de référence — temps de trajet');
  Object.entries(REF_TIME_CLASSES).forEach(([key,tc])=>{
    const row=document.createElement('div');
    row.className='legend-row active';
    row.dataset.key=key;
    row.innerHTML=
      '<span class="legend-line-time" style="background:'+tc.color+'"></span>'+
      '<span>'+tc.label+'</span>';
    row.addEventListener('click',()=>{
      if (activeRefTime.has(key)) {
        activeRefTime.delete(key);
        row.classList.remove('active');row.classList.add('muted');
      } else {
        activeRefTime.add(key);
        row.classList.add('active');row.classList.remove('muted');
      }
      applyRefTimeFilter();
    });
    refBk.appendChild(row);
  });
  // CSI→CMA (dashed) vs CMA→HD/HR (solid) — route type rows
  const typeLabel=document.createElement('div');
  typeLabel.style.cssText='font-size:10px;color:#6e7681;padding:3px 5px 1px;font-style:italic;';
  typeLabel.textContent='Type de route :';
  refBk.appendChild(typeLabel);

  [{
    svg: `<svg width="26" height="10" xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="5" x2="26" y2="5" stroke="#888" stroke-width="2.5" stroke-dasharray="5,3"/><text x="26" y="9" font-size="7" fill="#aaa" text-anchor="end">▶</text></svg>`,
    label: 'CSI → CMA'
  },{
    svg: `<svg width="26" height="10" xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="5" x2="26" y2="5" stroke="#888" stroke-width="3"/><text x="26" y="9" font-size="7" fill="#aaa" text-anchor="end">▶</text></svg>`,
    label: 'CMA → HD/HR'
  }].forEach(({svg,label})=>{
    const r=document.createElement('div');
    r.className='legend-row';
    r.style.gap='8px';
    r.innerHTML=svg+'<span>'+label+'</span>';
    refBk.appendChild(r);
  });
  el.appendChild(refBk);

  // ── Settlements ──
  const settBk=section('Localités');
  const srRow=document.createElement('div');
  srRow.className='legend-row';
  srRow.innerHTML='<span class="legend-dot-sm" style="background:#8e44ad"></span><span>Localité (zoom ≥ 9)</span>';
  settBk.appendChild(srRow);
  el.appendChild(settBk);
}

function updateRasterLegend() {
  const s=window._rasterStats;
  if (!s) return;
  const a=document.getElementById('lbl-access');
  if (a) {
    const mx=Math.round(s.access.max);
    a.innerHTML='<span>0 min</span><span>'+Math.round(mx/2)+' min</span><span>'+mx+' min</span>';
  }
  const r=document.getElementById('lbl-residual');
  if (r) {
    const mx=Math.round(s.residual.max);
    r.innerHTML='<span>0</span><span>'+Math.round(mx/2)+'</span><span>'+mx+'</span>';
  }
  const p=document.getElementById('lbl-population');
  if (p) {
    const mx=Math.round(s.population.max);
    p.innerHTML='<span>0</span><span>'+Math.round(mx/2)+'</span><span>'+mx+' hab/km²</span>';
  }
}

// ═══════════════════════════════════════════════════════════════════════
// DOWNLOAD — PNG & PDF
// ═══════════════════════════════════════════════════════════════════════

// Collect visible legend items for the export overlay
function getVisibleLegendItems() {
  const items=[];
  const vis=id=>{ const l=map.getLayer(id); return l&&map.getLayoutProperty(id,'visibility')!=='none'; };
  // Facilities
  if (vis('facilities-circle')) {
    [...activeFacCats].filter(k=>k!=='Autre').forEach(k=>{
      const v=CATS[k]||{color:CAT_OTHER};
      items.push({type:'circle',color:v.color,label:k+(CATS[k]?' — '+CATS[k].fr:'')});
    });
  }
  // Coverage
  if (vis('coverage-fill')) {
    [...activeCovCats].forEach(k=>{
      const v=CATS[k]||{color:CAT_OTHER};
      items.push({type:'fill',color:v.color,label:'Zone '+k});
    });
  }
  // Referral time
  if (vis('ref-csi-cma-line')||vis('ref-cma-hd-line')) {
    [...activeRefTime].forEach(key=>{
      const tc=REF_TIME_CLASSES[key];
      items.push({type:'line',color:tc.color,label:'Référence '+tc.label});
    });
  }
  // Settlements
  if (vis('sett-point'))
    items.push({type:'circle',color:'#8e44ad',label:'Localités'});
  return items;
}

// ── helper: draw a rounded rect (polyfill older browsers) ─────────────
function roundRect(ctx,x,y,w,h,r){
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x,y,w,h,r); }
  else {
    ctx.moveTo(x+r,y);
    ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);
    ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
    ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);
    ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);
    ctx.closePath();
  }
}

// ── draw the color ramp gradient directly on the export canvas ─────────
function drawRamp(ctx,x,y,w,h,stops){
  const grd=ctx.createLinearGradient(x,y,x+w,y);
  const vMin=stops[0][0],vMax=stops[stops.length-1][0];
  stops.forEach(([v,[r,g,b,a]])=>{
    grd.addColorStop((v-vMin)/(vMax-vMin),
      'rgba('+r+','+g+','+b+','+(a/255).toFixed(2)+')');
  });
  ctx.fillStyle=grd;
  ctx.fillRect(x,y,w,h);
}

// ── compute a nice scale bar value (metres → display string) ───────────
function niceMeters(m){
  const steps=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,20000,50000,100000];
  return steps.find(s=>s>=m*0.6)||steps[steps.length-1];
}
function metersLabel(m){ return m>=1000?(m/1000)+' km':m+' m'; }

function drawMapOverlays(ctx, W, H) {
  ctx.save();
  const CREDS='© MINSANTE/DOST : Yves Wasnyo 2026  |  Hydrosheds · Copernicus · OSM · Sentinel 2 · GHSL · WOF';
  const vis=id=>{ const l=map.getLayer(id); return l&&map.getLayoutProperty(id,'visibility')!=='none'; };
  const dpr=window.devicePixelRatio||1;
  const PAD=12;

  // ══ 1. TITLE BOX (top-left) ══════════════════════════════════════════
  {
    const lines=[
      {text:'District de Santé de Mokolo',font:'bold 15px Segoe UI,sans-serif',color:'#ffffff'},
      {text:'Accessibilité & Couverture — Établissements de Santé Publics',
        font:'11px Segoe UI,sans-serif',color:'#c9d1d9'},
      {text:new Date().toLocaleDateString('fr-FR',{year:'numeric',month:'long',day:'numeric'}),
        font:'10px Segoe UI,sans-serif',color:'#8b949e'},
    ];
    const BW=360, BH=PAD*2+lines.length*20;
    const TX=16, TY=16;
    ctx.fillStyle='rgba(15,52,96,0.90)';
    roundRect(ctx,TX,TY,BW,BH,6);ctx.fill();
    ctx.strokeStyle='rgba(233,69,96,0.70)';ctx.lineWidth=1.5;
    roundRect(ctx,TX,TY,BW,BH,6);ctx.stroke();
    lines.forEach((l,i)=>{
      ctx.font=l.font;ctx.fillStyle=l.color;
      ctx.fillText(l.text,TX+PAD,TY+PAD+14+i*20);
    });
  }

  // ══ 2. NORTH ARROW (top-right) ═══════════════════════════════════════
  {
    const AX=W-50, AY=50, AR=26;
    // Outer circle
    ctx.fillStyle='rgba(15,52,96,0.85)';
    ctx.beginPath();ctx.arc(AX,AY,AR+4,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='rgba(233,69,96,0.6)';ctx.lineWidth=1;
    ctx.beginPath();ctx.arc(AX,AY,AR+4,0,Math.PI*2);ctx.stroke();
    // North half (red)
    ctx.fillStyle='#e94560';
    ctx.beginPath();
    ctx.moveTo(AX,AY-AR);ctx.lineTo(AX-10,AY+2);ctx.lineTo(AX,AY-4);ctx.closePath();ctx.fill();
    ctx.beginPath();
    ctx.moveTo(AX,AY-AR);ctx.lineTo(AX+10,AY+2);ctx.lineTo(AX,AY-4);ctx.closePath();
    ctx.fillStyle='rgba(233,69,96,0.5)';ctx.fill();
    // South half (white/grey)
    ctx.fillStyle='#c9d1d9';
    ctx.beginPath();
    ctx.moveTo(AX,AY+AR);ctx.lineTo(AX-10,AY-2);ctx.lineTo(AX,AY+4);ctx.closePath();ctx.fill();
    ctx.beginPath();
    ctx.moveTo(AX,AY+AR);ctx.lineTo(AX+10,AY-2);ctx.lineTo(AX,AY+4);ctx.closePath();
    ctx.fillStyle='rgba(200,209,217,0.5)';ctx.fill();
    // N label
    ctx.fillStyle='#ffffff';ctx.font='bold 13px Segoe UI,sans-serif';
    ctx.textAlign='center';
    ctx.fillText('N',AX,AY-AR-7);
    ctx.textAlign='start';
  }

  // ══ 3. SCALE BAR (bottom-left) ═══════════════════════════════════════
  {
    const ctr=map.getCenter();
    const z=map.getZoom();
    const lat=ctr.lat*Math.PI/180;
    const metersPerPx=(40075016.686*Math.cos(lat))/(256*Math.pow(2,z))/dpr;
    const targetPx=100; // aim for ~100px bar
    const targetMeters=targetPx*metersPerPx;
    const nice=niceMeters(targetMeters);
    const barPx=nice/metersPerPx;
    const BX=16, BY=H-50;
    // Shadow
    ctx.shadowColor='rgba(0,0,0,0.6)';ctx.shadowBlur=4;
    // White top half
    ctx.fillStyle='#ffffff';
    ctx.fillRect(BX,BY,barPx,8);
    // Dark bottom half (creates two-tone bar)
    ctx.fillStyle='#333333';
    ctx.fillRect(BX+barPx/2,BY,barPx/2,8);
    // Tick marks
    ctx.shadowBlur=0;
    ctx.strokeStyle='#333333';ctx.lineWidth=1.2;
    [0,0.5,1].forEach(t=>{
      ctx.beginPath();ctx.moveTo(BX+t*barPx,BY-3);ctx.lineTo(BX+t*barPx,BY+9);ctx.stroke();
    });
    // Labels
    ctx.fillStyle='#1a1a2e';ctx.font='bold 10px Segoe UI,sans-serif';
    ctx.textAlign='center';
    ctx.fillText('0',BX,BY+20);
    ctx.fillText(metersLabel(nice/2),BX+barPx/2,BY+20);
    ctx.fillText(metersLabel(nice),BX+barPx,BY+20);
    // "Échelle" label
    ctx.textAlign='start';ctx.font='9px Segoe UI,sans-serif';ctx.fillStyle='#555555';
    ctx.fillText('Échelle',BX,BY-6);
    ctx.textAlign='start';
  }

  // ══ 4. LEGEND BOX (right side) ═══════════════════════════════════════
  {
    const PAD2=10, LH=19, RW=230, RAMP_H=14;
    let rows=[];  // {type, ...}

    // Raster ramps (if visible)
    if (vis('accessibility-raster')) {
      const mx=window._rasterStats?Math.round(window._rasterStats.access.max):240;
      rows.push({type:'ramp-title',text:'Accessibilité (min de trajet)'});
      rows.push({type:'ramp',stops:STOPS_ACCESS,label0:'0 min',labelMid:Math.round(mx/2)+' min',labelMax:mx+' min'});
    }
    if (vis('residual-raster')) {
      const mx=window._rasterStats?Math.round(window._rasterStats.residual.max):700;
      rows.push({type:'ramp-title',text:'Population résiduelle'});
      rows.push({type:'ramp',stops:STOPS_RESID,label0:'0',labelMid:Math.round(mx/2)+'',labelMax:mx+''});
    }
    if (vis('population-raster')) {
      const mx=window._rasterStats?Math.round(window._rasterStats.population.max):1000;
      rows.push({type:'ramp-title',text:'Densité de population (hab/km²)'});
      rows.push({type:'ramp',stops:STOPS_POP,label0:'0',labelMid:Math.round(mx/2)+'',labelMax:mx+' hab/km²'});
    }
    // Facilities
    if (vis('facilities-circle')) {
      rows.push({type:'section-title',text:'Établissements de santé'});
      [...activeFacCats].filter(k=>CATS[k]).forEach(k=>{
        rows.push({type:'circle',color:CATS[k].color,
          text:k+' — '+CATS[k].fr+' ('+CATS[k].beds+' lits)'});
      });
      if (activeFacCats.has('Autre'))
        rows.push({type:'circle',color:CAT_OTHER,text:'Autre établissement'});
    }
    // Coverage
    if (vis('coverage-fill')) {
      rows.push({type:'section-title',text:'Zones de couverture'});
      [...activeCovCats].filter(k=>CATS[k]).forEach(k=>{
        rows.push({type:'fill',color:CATS[k].color,
          text:'Zone '+k+' — '+CATS[k].beds+' lits'});
      });
    }
    // Referral time
    if (vis('ref-csi-cma-line')||vis('ref-cma-hd-line')) {
      rows.push({type:'section-title',text:'Routes de référence'});
      [...activeRefTime].forEach(key=>{
        const tc=REF_TIME_CLASSES[key];
        rows.push({type:'line',color:tc.color,text:tc.label});
      });
      rows.push({type:'note',text:'Tireté = CSI→CMA  |  Continu = CMA→HD/HR'});
    }
    // Settlements
    if (vis('sett-point'))
      rows.push({type:'circle',color:'#8e44ad',text:'Localités / Agglomérations'});

    if (rows.length===0) {
      // No legend items — still draw credits bar below, skip legend box
    } else {

    // Compute total height
    let totalH=PAD2*2+16; // header
    rows.forEach(r=>{
      if (r.type==='ramp')          totalH+=RAMP_H+14+4;
      else if (r.type==='ramp-title'||r.type==='section-title') totalH+=18;
      else if (r.type==='note')     totalH+=14;
      else                          totalH+=LH;
    });

    const LX=W-RW-16, LY=90;
    ctx.fillStyle='rgba(22,27,34,0.90)';
    roundRect(ctx,LX,LY,RW,totalH,6);ctx.fill();
    ctx.strokeStyle='rgba(233,69,96,0.55)';ctx.lineWidth=1;
    roundRect(ctx,LX,LY,RW,totalH,6);ctx.stroke();

    // Header
    ctx.fillStyle='#e94560';ctx.font='bold 11px Segoe UI,sans-serif';
    ctx.fillText('LÉGENDE',LX+PAD2,LY+PAD2+10);
    let cy=LY+PAD2+22;

    rows.forEach(r=>{
      if (r.type==='ramp-title') {
        ctx.fillStyle='#8b949e';ctx.font='bold 9.5px Segoe UI,sans-serif';
        ctx.fillText(r.text.toUpperCase(),LX+PAD2,cy+10);
        cy+=18;
      } else if (r.type==='section-title') {
        ctx.fillStyle='#8b949e';ctx.font='bold 9.5px Segoe UI,sans-serif';
        ctx.fillText(r.text.toUpperCase(),LX+PAD2,cy+10);
        cy+=18;
      } else if (r.type==='ramp') {
        drawRamp(ctx,LX+PAD2,cy,RW-PAD2*2,RAMP_H,r.stops);
        ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=0.5;
        ctx.strokeRect(LX+PAD2,cy,RW-PAD2*2,RAMP_H);
        cy+=RAMP_H+2;
        ctx.fillStyle='#6e7681';ctx.font='8.5px Segoe UI,sans-serif';
        ctx.textAlign='left'; ctx.fillText(r.label0,LX+PAD2,cy+10);
        ctx.textAlign='center';ctx.fillText(r.labelMid,LX+RW/2,cy+10);
        ctx.textAlign='right'; ctx.fillText(r.labelMax,LX+RW-PAD2,cy+10);
        ctx.textAlign='start';
        cy+=14;
      } else if (r.type==='circle') {
        ctx.fillStyle=r.color;
        ctx.beginPath();ctx.arc(LX+PAD2+6,cy+7,5,0,Math.PI*2);ctx.fill();
        ctx.fillStyle='#c9d1d9';ctx.font='10px Segoe UI,sans-serif';
        ctx.fillText(r.text,LX+PAD2+16,cy+11);
        cy+=LH;
      } else if (r.type==='line') {
        ctx.strokeStyle=r.color;ctx.lineWidth=3;
        ctx.beginPath();ctx.moveTo(LX+PAD2,cy+7);ctx.lineTo(LX+PAD2+20,cy+7);ctx.stroke();
        ctx.fillStyle='#c9d1d9';ctx.font='10px Segoe UI,sans-serif';
        ctx.fillText(r.text,LX+PAD2+26,cy+11);
        cy+=LH;
      } else if (r.type==='fill') {
        ctx.globalAlpha=0.6;ctx.fillStyle=r.color;
        ctx.fillRect(LX+PAD2,cy+2,16,10);
        ctx.globalAlpha=1;
        ctx.fillStyle='#c9d1d9';ctx.font='10px Segoe UI,sans-serif';
        ctx.fillText(r.text,LX+PAD2+22,cy+11);
        cy+=LH;
      } else if (r.type==='note') {
        ctx.fillStyle='#484f58';ctx.font='italic 8.5px Segoe UI,sans-serif';
        ctx.fillText(r.text,LX+PAD2,cy+10);
        cy+=14;
      }
    });
  }  // end else (legend has rows)
  }  // end section 4 legend block

  // ══ 5. CREDITS BAR (bottom) ══════════════════════════════════════════
  ctx.fillStyle='rgba(13,17,23,0.82)';
  ctx.fillRect(0,H-24,W,24);
  ctx.fillStyle='#8b949e';ctx.font='9px Segoe UI,sans-serif';
  ctx.fillText(CREDS,10,H-8);

  ctx.restore();
}

async function captureMapCanvas() {
  return new Promise(resolve=>{
    map.once('idle',()=>{
      const mc=map.getCanvas();
      const W=mc.width,H=mc.height;
      const out=Object.assign(document.createElement('canvas'),{width:W,height:H});
      const ctx=out.getContext('2d');
      ctx.drawImage(mc,0,0);
      drawMapOverlays(ctx,W,H);
      resolve(out);
    });
    map.triggerRepaint();
  });
}

async function downloadPNG() {
  const status=document.getElementById('export-status');
  status.textContent='Génération PNG…';status.className='export-status';
  try {
    const canvas=await captureMapCanvas();
    const a=document.createElement('a');
    a.download='mokolo-carte-'+new Date().toISOString().slice(0,10)+'.png';
    a.href=canvas.toDataURL('image/png');
    a.click();
    status.textContent='PNG téléchargé ✓';
    setTimeout(()=>{ status.textContent=''; },4000);
  } catch(e) {
    status.textContent='Erreur: '+e.message;status.className='export-status error';
    console.error(e);
  }
}

async function downloadPDF() {
  const status=document.getElementById('export-status');
  status.textContent='Génération PDF…';status.className='export-status';
  try {
    const canvas=await captureMapCanvas();
    const W=canvas.width,H=canvas.height;
    const orient=W>=H?'landscape':'portrait';
    const doc=new jsPDF({orientation:orient,unit:'px',format:[W,H],compress:true});
    doc.addImage(canvas.toDataURL('image/jpeg',0.92),'JPEG',0,0,W,H);
    doc.save('mokolo-carte-'+new Date().toISOString().slice(0,10)+'.pdf');
    status.textContent='PDF téléchargé ✓';
    setTimeout(()=>{ status.textContent=''; },4000);
  } catch(e) {
    status.textContent='Erreur: '+e.message;status.className='export-status error';
    console.error(e);
  }
}

// ── Wire download buttons ────────────────────────────────────────────
document.getElementById('btn-png').addEventListener('click',downloadPNG);
document.getElementById('btn-pdf').addEventListener('click',downloadPDF);
