(() => {
  const layer = document.querySelector('#hero .hero-sea');
  if (!layer || !window.matchMedia || !('IntersectionObserver' in window)) return;

  const still = layer.querySelector('img');
  const canvas = layer.querySelector('canvas');
  const motion = matchMedia('(prefers-reduced-motion: no-preference)');

  const width = 1092;
  const height = 1941;
  const horizon = 833;
  const frameInterval = 50;
  const loopDuration = 5000;
  let visible = false;
  let failed = false;
  let contextLost = false;
  let gl;
  let renderer;
  let images;
  let loading = false;
  let frame = null;
  let lastPaint = null;
  let elapsed = 0;
  let resized = true;

  const vertexSource = `#version 300 es
    precision highp float;
    in vec2 aUv;
    uniform sampler2D uMotion;
    uniform vec2 uImageSize;
    uniform float uHorizon;
    uniform float uPhase;
    uniform vec4 uWave;
    out vec2 vPosition;
    out vec2 vSample;
    out vec4 vSlopeTransform;
    out float vLight;
    out float vAdvance;

    const float tau = 6.28318530718;
    const float blendStart = 1350.0;
    const float blendEnd = 1520.0;

    vec2 displacement(vec2 position) {
      // The RGB atlas stacks three 273 x 149 strips. A byte of 128 is zero.
      // The channels store the four time coefficients for X, followed by Y.
      vec2 field = clamp(vec2(position.x, position.y - blendStart)
        / vec2(uImageSize.x - 1.0, uImageSize.y - 1.0 - blendStart), 0.0, 1.0);
      vec2 samplePixel = vec2(0.5) + field * vec2(272.0, 148.0);
      vec2 atlasSize = vec2(273.0, 447.0);
      vec3 first = texture(uMotion, samplePixel / atlasSize).rgb * 255.0 - 128.0;
      vec3 second = texture(uMotion, (samplePixel + vec2(0.0, 149.0)) / atlasSize).rgb * 255.0 - 128.0;
      vec2 third = texture(uMotion, (samplePixel + vec2(0.0, 298.0)) / atlasSize).rg * 255.0 - 128.0;
      return vec2(dot(vec4(first, second.r), uWave) * (4.0 / 127.0),
        dot(vec4(second.gb, third), uWave) * (12.0 / 127.0));
    }

    void main() {
      gl_Position = vec4(aUv.x * 2.0 - 1.0, 1.0 - aUv.y * 2.0, 0.0, 1.0);
      vec2 position = aUv * uImageSize - 0.5;
      vec2 anchor = position;
      float nearWeight = smoothstep(blendStart, blendEnd, position.y);
      vLight = 1.0;
      vAdvance = 0.0;
      vSlopeTransform = vec4(1.0, 0.0, 0.0, 1.0);

      if (position.y > uHorizon && nearWeight < 1.0) {
        float depth = (position.y - uHorizon) / (uImageSize.y - 1.0 - uHorizon);
        float perspective = 0.23 + 0.77 * depth;
        float peak = uHorizon + 128.0;
        float peakPerspective = 0.23 + 0.77 * 128.0 / (uImageSize.y - 1.0 - uHorizon);
        float decay = 1.0 - 0.62 * smoothstep(peak, blendEnd, position.y);
        float strength = smoothstep(uHorizon, uHorizon + 96.0, position.y)
          * pow(min(perspective, peakPerspective), 1.32) * decay * (1.0 - nearWeight);
        float x = (position.x - uImageSize.x * 0.5) / perspective;
        float y = 1350.0 * log(perspective);
        float swell = (y / 159.0 + x / 610.0) * tau
          + 0.53 * sin(x / 141.0) + 0.4 * sin((x - y) / 122.0) - 2.0 * uPhase;
        float crossSwell = (y / 92.0 - x / 360.0) * tau
          + 0.6 * sin((x + y) / 97.0) - 3.0 * uPhase;
        float ripple = (y / 48.0 + x / 245.0) * tau
          + 0.53 * sin(x / 77.0) - 5.0 * uPhase;
        float side = smoothstep(0.0, 24.0, min(position.x, uImageSize.x - 1.0 - position.x));
        anchor += strength * vec2(
          side * (10.5 * cos(swell) - 4.6 * cos(crossSwell) + 1.3 * sin(ripple)),
          11.8 * sin(swell) + 4.9 * sin(crossSwell) + 1.65 * sin(ripple));
        vLight += strength * (0.025 * cos(swell) + 0.012 * cos(crossSwell) + 0.008 * cos(ripple));
      }

      vSample = anchor;
      if (position.y > blendStart) {
        for (int step = 0; step < 3; step++) {
          vSample = anchor - displacement(vSample);
        }
        vAdvance = anchor.y - vSample.y;

        // Inverse-transpose of the wave deformation, applied to the slope map.
        vec2 dx = (displacement(vSample + vec2(3.0, 0.0)) - displacement(vSample - vec2(3.0, 0.0))) / 6.0;
        vec2 dy = (displacement(vSample + vec2(0.0, 3.0)) - displacement(vSample - vec2(0.0, 3.0))) / 6.0;
        float determinant = max(0.4, (1.0 + dx.x) * (1.0 + dy.y) - dx.y * dy.x);
        vSlopeTransform = vec4(1.0 + dy.y, -dx.y, -dy.x, 1.0 + dx.x) / determinant;
      }
      vPosition = position;
    }`;

  const fragmentSource = `#version 300 es
    precision highp float;
    uniform sampler2D uSea;
    uniform sampler2D uSlopes;
    uniform vec2 uImageSize;
    uniform float uHorizon;
    in vec2 vPosition;
    in vec2 vSample;
    in vec4 vSlopeTransform;
    in float vLight;
    in float vAdvance;
    out vec4 color;

    float reflection(vec2 slope) {
      vec2 distance = slope - vec2(0.15, 0.34);
      float squared = dot(distance, distance);
      return 0.76 * exp(-12.0 * squared) + 0.24 * exp(-3.7 * squared);
    }

    void main() {
      vec4 base = texture(uSea, (vPosition + 0.5) / uImageSize);
      if (base.a < 0.999 || vPosition.y <= uHorizon) {
        color = base;
        return;
      }
      vec4 water = texture(uSea, (vSample + 0.5) / uImageSize);
      if (water.a < 0.999) {
        color = base;
        return;
      }

      float highlight = 0.0;
      float weight = smoothstep(1350.0, 1520.0, vPosition.y)
        * smoothstep(0.0, 55.0, min(vPosition.x, uImageSize.x - 1.0 - vPosition.x))
        * smoothstep(0.0, 72.0, uImageSize.y - 1.0 - vPosition.y);
      if (weight > 0.0) {
        // R and G encode X and Y slopes over the foreground, with zero at 128.
        vec2 field = clamp(vec2(vSample.x, vSample.y - 1350.0)
          / vec2(uImageSize.x - 1.0, uImageSize.y - 1.0 - 1350.0), 0.0, 1.0);
        vec2 uv = (vec2(0.5) + field * vec2(545.0, 295.0)) / vec2(546.0, 296.0);
        vec2 slope = (texture(uSlopes, uv).rg * 255.0 - 128.0) * (1.25 / 127.0);
        vec2 moved = vec2(dot(vSlopeTransform.xy, slope), dot(vSlopeTransform.zw, slope));
        moved.y += 0.014 * vAdvance * min(1.0, (abs(slope.x) + abs(slope.y)) / 0.4);
        float headroom = 1.0 - 0.57 * smoothstep(132.0 / 255.0, 222.0 / 255.0, water.g);
        highlight = (32.0 / 255.0) * weight * headroom * (reflection(moved) - reflection(slope));
      }
      vec3 rgb = clamp(water.rgb * vLight + vec3(1.06, 1.0, 0.89) * highlight, 0.0, base.a);
      color = vec4(rgb, base.a);
    }`;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message || 'Could not compile the sea shader');
    }
    return shader;
  }

  function bindTexture(source, unit, premultiply) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  function bindMesh(program) {
    // Evaluate the displacement on a mesh. The fragment shader samples the
    // image and lights it using the interpolated position and slope transform.
    const columns = 182;
    const waterRows = 185;
    const stride = columns + 1;
    const vertices = new Float32Array(stride * (waterRows + 2) * 2);
    const indices = new Uint16Array(columns * (waterRows + 1) * 6);
    for (let row = 0; row <= waterRows + 1; row++) {
      const y = row === 0 ? 0 : (horizon + (row - 1) * (height - horizon) / waterRows) / height;
      for (let col = 0; col <= columns; col++) {
        const index = row * stride + col;
        vertices[index * 2] = col / columns;
        vertices[index * 2 + 1] = y;
        if (row <= waterRows && col < columns) {
          const offset = (row * columns + col) * 6;
          const nextRow = index + stride;
          indices.set([index, nextRow, index + 1, index + 1, nextRow, nextRow + 1], offset);
        }
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const uv = gl.getAttribLocation(program, 'aUv');
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    return indices.length;
  }

  function createRenderer(motionMap, slopeMap) {
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(message || 'Could not link the sea shaders');
    }
    gl.useProgram(program);
    bindTexture(still, 0, true);
    bindTexture(motionMap, 1, false);
    bindTexture(slopeMap, 2, false);
    gl.uniform1i(gl.getUniformLocation(program, 'uSea'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uMotion'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'uSlopes'), 2);
    gl.uniform2f(gl.getUniformLocation(program, 'uImageSize'), width, height);
    gl.uniform1f(gl.getUniformLocation(program, 'uHorizon'), horizon);
    return {
      count: bindMesh(program),
      phase: gl.getUniformLocation(program, 'uPhase'),
      wave: gl.getUniformLocation(program, 'uWave'),
    };
  }

  function loadMap(filename) {
    const image = new Image();
    image.src = new URL(filename, still.src);
    return image.decode().then(() => image);
  }

  function shouldAnimate() {
    return visible && motion.matches && !document.hidden && !contextLost && !failed;
  }

  function showAnimation(show) {
    canvas.hidden = !show;
    layer.classList.toggle('is-animated', show);
  }

  function render(time) {
    frame = null;
    if (!shouldAnimate()) {
      sync();
      return;
    }
    if (!renderer) return;

    if (resized || lastPaint === null || time - lastPaint >= frameInterval - 2) {
      if (resized) {
        const w = layer.clientWidth;
        const h = layer.clientHeight;
        if (!w || !h) return;
        const scale = Math.min(window.devicePixelRatio || 1, 1.5, width / w, height / h, Math.sqrt(800000 / (w * h)));
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        gl.viewport(0, 0, canvas.width, canvas.height);
        resized = false;
      }
      if (lastPaint !== null) elapsed = (elapsed + time - lastPaint) % loopDuration;
      lastPaint = time;
      const phase = elapsed / loopDuration * Math.PI * 2;
      gl.uniform1f(renderer.phase, phase);
      gl.uniform4f(renderer.wave, Math.sin(phase), Math.cos(phase) - 1, Math.sin(2 * phase), Math.cos(2 * phase) - 1);
      gl.drawElements(gl.TRIANGLES, renderer.count, gl.UNSIGNED_SHORT, 0);
      if (canvas.hidden && !gl.isContextLost()) showAnimation(true);
    }
    frame = requestAnimationFrame(render);
  }

  async function prepareRenderer() {
    loading = true;
    try {
      if (!gl) {
        gl = canvas.getContext('webgl2', {
          alpha: true,
          antialias: false,
          depth: false,
          stencil: false,
          powerPreference: 'low-power',
        });
        if (!gl) {
          failed = true;
          return;
        }
      }
      images ??= Promise.all([still.decode(), loadMap('02-sea-motion.png'), loadMap('02-sea-slopes.png')]);
      const [, motionMap, slopeMap] = await images;
      if (!contextLost && !gl.isContextLost()) {
        renderer = createRenderer(motionMap, slopeMap);
        resized = true;
      }
    } catch (error) {
      if (!contextLost && !gl?.isContextLost()) {
        failed = true;
        console.warn('Using the static sea layer.', error);
      }
    } finally {
      loading = false;
      if (renderer || failed) sync();
    }
  }

  function sync() {
    if (!shouldAnimate()) {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      lastPaint = null;
      showAnimation(false);
    } else if (renderer) {
      if (frame === null) frame = requestAnimationFrame(render);
    } else if (!loading) {
      prepareRenderer();
    }
  }

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    contextLost = true;
    renderer = null;
    sync();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    sync();
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(layer.closest('#hero'));
  const resize = () => { resized = true; sync(); };
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(layer);
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', sync);
  if (motion.addEventListener) motion.addEventListener('change', sync);
  else motion.addListener(sync);
})();
