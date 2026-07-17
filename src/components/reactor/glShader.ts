export interface GLProgram {
  gl: WebGLRenderingContext;
  u: Record<string, WebGLUniformLocation | null>;
}

const VERTEX_SHADER = 'attribute vec2 a;varying vec2 v;void main(){v=a;gl_Position=vec4(a,0.,1.);}';

const FRAGMENT_SHADER =
  'precision mediump float;varying vec2 v;uniform float u_t,u_surge,u_phase,u_glow,u_storm,u_od,u_soft,u_grow;' +
  'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}' +
  'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1.,0.)),f.x),mix(h(i+vec2(0.,1.)),h(i+vec2(1.,1.)),f.x),f.y);}' +
  'float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}' +
  'void main(){vec2 uv=v;float r=length(uv);' +
  'float lim=u_soft>.5?.985:.68;if(r>lim){gl_FragColor=vec4(0.);return;}' +
  'float t=u_t*.22;' +
  'vec2 q=vec2(fbm(uv*3.+vec2(t,0.)),fbm(uv*3.-vec2(0.,t*1.3)));' +
  'float m=fbm(uv*(3.6+u_od)+q*(1.6+u_od*.6)+vec2(t*2.2,-t*1.1));' +
  'float storm=pow(m,2.3-u_storm)*(.5+.85*u_surge);' +
  'vec3 deep=vec3(.015,.12,.18),mid=vec3(.14,.62,.83),hot=vec3(.78,.97,1.);' +
  'vec3 col=mix(deep,mid,clamp(storm*1.7,0.,1.));' +
  'col=mix(col,hot,pow(max(storm-.32,0.)*1.7,1.7));' +
  'col+=vec3(1.)*exp(-r*r*13.)*(.5+.5*u_surge);' +
  'float wr=.05+u_phase*.66;' +
  'col+=vec3(.8,.98,1.)*exp(-pow((r-wr)*24.,2.))*(1.-u_phase)*.85;' +
  'col+=vec3(.5,.9,1.)*smoothstep(.035,.0,abs(r-.65))*(.3+.7*u_surge)*(1.-u_soft);' +
  'col*=u_glow;' +
  'float a=u_soft>.5?exp(-pow(r/(.34+.30*u_grow),2.)*2.2):smoothstep(.68,.63,r);' +
  'gl_FragColor=vec4(col*a,a);}';

export function initGL(el: HTMLCanvasElement): GLProgram | null {
  const gl = el.getContext('webgl', { alpha: true, premultipliedAlpha: true });
  if (!gl) return null;
  const mk = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    return sh;
  };
  const prog = gl.createProgram()!;
  const vs = mk(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fs = mk(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vs || !fs) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.viewport(0, 0, 448, 448);
  const u: Record<string, WebGLUniformLocation | null> = {};
  ['u_t', 'u_surge', 'u_phase', 'u_glow', 'u_storm', 'u_od', 'u_soft', 'u_grow'].forEach((k) => {
    u[k] = gl.getUniformLocation(prog, k);
  });
  return { gl, u };
}

export interface DrawCoreGLParams {
  t: number;
  surge: number;
  phase: number;
  overdrive: boolean;
  glowFactor: number;
  burnRate: number;
  soft: boolean;
}

export function drawCoreGL(program: GLProgram, params: DrawCoreGLParams): void {
  const { gl, u } = program;
  const burnT = Math.max(0, Math.min(1, (params.burnRate - 28000) / 140000));
  gl.uniform1f(u.u_t, params.t);
  gl.uniform1f(u.u_surge, params.surge);
  gl.uniform1f(u.u_phase, params.phase);
  gl.uniform1f(u.u_glow, 0.75 + params.glowFactor * 0.5);
  gl.uniform1f(u.u_storm, 0.25 + burnT * 0.65);
  gl.uniform1f(u.u_od, params.overdrive ? 1 : 0);
  gl.uniform1f(u.u_soft, params.soft ? 1 : 0);
  gl.uniform1f(u.u_grow, Math.min(1, params.surge * 0.7 + burnT * 0.5 + (params.overdrive ? 0.25 : 0)));
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
