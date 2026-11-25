(() => {
  const landscape = document.querySelector('#hero > .hero-landscape');
  if (!landscape || !window.matchMedia || !('IntersectionObserver' in window)) return;

  const hero = landscape.parentElement;
  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  const portraitCanvas = hero.querySelector('.hero-portrait-render');
  const portraitImages = [...hero.querySelectorAll('.hero-portrait[data-depth-map]')];
  const maxDepthStep = 12;
  let gl;
  let portraitSources;
  let paintPortraits;
  let preparingPortraits = false;
  let portraitsFailed = false;
  let contextLost = false;
  let visible = false;
  let frame = null;
  let lastFrame = null;
  let pointer = null;
  let pointerX = 0;
  let pointerY = 0;

  function requestFrame() {
    if (visible && motion.matches && !document.hidden && frame === null) frame = requestAnimationFrame(render);
  }

  function render(time) {
    frame = null;
    if (!visible || !motion.matches || document.hidden) return;

    const { top, right, bottom, left, width, height } = hero.getBoundingClientRect();
    const scrollY = Math.min(Math.max(0, -top) * .14, height * .08);
    const inside = pointer && pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= bottom;
    const targetX = inside ? ((pointer.x - left) / width * 2 - 1) * 8 : 0;
    const targetY = inside ? ((pointer.y - top) / height * 2 - 1) * 6 : 0;

    const elapsed = lastFrame === null ? 16 : time - lastFrame;
    const ease = 1 - Math.exp(-elapsed / 85);
    pointerX += (targetX - pointerX) * ease;
    pointerY += (targetY - pointerY) * ease;
    const moving = Math.abs(targetX - pointerX) > .05 || Math.abs(targetY - pointerY) > .05;
    if (!moving) {
      pointerX = targetX;
      pointerY = targetY;
    }

    landscape.style.setProperty('--scroll-y', `${scrollY}px`);
    landscape.style.setProperty('--pointer-x', `${pointerX}px`);
    landscape.style.setProperty('--pointer-y', `${pointerY}px`);
    renderPortraits(width, height, scrollY);
    lastFrame = moving ? time : null;
    if (moving) requestFrame();
  }

  function showPortraitCanvas(show) {
    if (!portraitCanvas || portraitCanvas.hidden === !show) return;
    portraitCanvas.hidden = !show;
    hero.classList.toggle('portraits-animated', show);
  }

  function renderPortraits(width, height, scrollY) {
    if (!width || !height || !portraitCanvas || !portraitImages.length || portraitsFailed || contextLost) return;
    if (!paintPortraits) {
      if (!preparingPortraits) preparePortraits();
      return;
    }

    // Brighter, nearer points follow the pointer farther and rise faster as the page scrolls.
    const scrollLimit = width * .02;
    const scrollShift = scrollLimit * Math.tanh(scrollY * .85 / scrollLimit);
    const x = pointerX * 1.6;
    const y = pointerY * 1.6 - scrollShift;
    const moving = !!(pointerX || pointerY || scrollY);
    if (moving) paintPortraits(width, height, x, y);
    showPortraitCanvas(moving);
  }

  async function loadPortrait(image) {
    const depth = new Image();
    depth.src = image.dataset.depthMap;
    await Promise.all([image.decode(), depth.decode()]);
    if (depth.naturalWidth !== image.naturalWidth || depth.naturalHeight !== image.naturalHeight) {
      throw new Error(`Depth map dimensions differ from ${image.getAttribute('src')}`);
    }
    return { image, depth };
  }

  async function preparePortraits() {
    preparingPortraits = true;
    try {
      gl ??= portraitCanvas.getContext('webgl2', {
        alpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power',
      });
      if (!gl) {
        portraitsFailed = true;
        return;
      }
      portraitSources ??= Promise.all(portraitImages.map(loadPortrait));
      const sources = await portraitSources;
      if (contextLost || gl.isContextLost()) return;
      paintPortraits = createPortraitRenderer(sources);
      requestFrame();
    } catch (error) {
      if (!contextLost && !gl?.isContextLost()) {
        portraitsFailed = true;
        console.warn('Using the static portraits.', error);
      }
    } finally {
      preparingPortraits = false;
    }
  }

  function sampleDepth(image, depth, columns, rows) {
    const scratch = document.createElement('canvas');
    scratch.width = columns;
    scratch.height = rows;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, columns, rows);
    const colorPixels = ctx.getImageData(0, 0, columns, rows).data;
    ctx.clearRect(0, 0, columns, rows);
    ctx.drawImage(depth, 0, 0, columns, rows);
    const depthPixels = ctx.getImageData(0, 0, columns, rows).data;

    // Extend nearby depth across the transparent edges so the black background
    // of the map cannot pull hair and fingers away from their own silhouette.
    const values = new Int16Array(columns * rows).fill(-1);
    const queue = new Uint16Array(values.length);
    let tail = 0;
    for (let i = 0; i < values.length; i++) {
      if (colorPixels[i * 4 + 3] < 192) continue;
      values[i] = depthPixels[i * 4];
      queue[tail++] = i;
    }
    if (!tail) throw new Error('Portrait has no opaque depth samples');

    function extend(from, to) {
      if (values[to] !== -1) return;
      values[to] = values[from];
      queue[tail++] = to;
    }
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const column = i % columns;
      if (column > 0) extend(i, i - 1);
      if (column < columns - 1) extend(i, i + 1);
      if (i >= columns) extend(i, i - columns);
      if (i < values.length - columns) extend(i, i + columns);
    }
    return limitDepthSlope(values, columns);
  }

  function limitDepthSlope(values, columns) {
    // Bound adjacent depth samples in both directions. Averaging the envelopes
    // spreads abrupt changes across nearby vertices instead of folding over an edge.
    const lower = values.slice();
    const upper = values.slice();
    function includeNeighbor(i, neighbor) {
      lower[i] = Math.min(lower[i], lower[neighbor] + maxDepthStep);
      upper[i] = Math.max(upper[i], upper[neighbor] - maxDepthStep);
    }
    for (let i = 0; i < values.length; i++) {
      if (i % columns > 0) includeNeighbor(i, i - 1);
      if (i >= columns) includeNeighbor(i, i - columns);
    }
    for (let i = values.length - 1; i >= 0; i--) {
      if (i % columns < columns - 1) includeNeighbor(i, i + 1);
      if (i < values.length - columns) includeNeighbor(i, i + columns);
    }
    return Float32Array.from(lower, (value, i) => (value + upper[i]) / (2 * 255));
  }

  function bindPortrait({ image, depth }) {
    const columns = 129;
    const rows = Math.round(128 * image.naturalHeight / image.naturalWidth) + 1;
    const values = sampleDepth(image, depth, columns, rows);
    const vertices = new Float32Array(values.length * 3);
    const indices = new Uint16Array((columns - 1) * (rows - 1) * 6);
    let offset = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const i = row * columns + col;
        vertices.set([col / (columns - 1), row / (rows - 1), values[i]], i * 3);
        if (row < rows - 1 && col < columns - 1) {
          const below = i + columns;
          indices.set([i, below, i + 1, i + 1, below, below + 1], offset);
          offset += 6;
        }
      }
    }

    const mesh = gl.createVertexArray();
    gl.bindVertexArray(mesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    return { image, mesh, texture, count: indices.length, cells: [columns - 1, rows - 1] };
  }

  function createPortraitRenderer(sources) {
    const program = gl.createProgram();
    function attachShader(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
      const message = gl.getShaderInfoLog(shader);
      if (compiled) gl.attachShader(program, shader);
      gl.deleteShader(shader);
      if (!compiled) throw new Error(message || 'Could not compile the portrait shader');
    }
    attachShader(gl.VERTEX_SHADER, `#version 300 es
      layout(location = 0) in vec3 aSample;
      uniform vec2 uHeroSize;
      uniform vec2 uOrigin;
      uniform vec2 uSize;
      uniform mat2 uRotation;
      uniform vec2 uShift;
      uniform float uRelief;
      out vec2 vUv;
      void main() {
        vUv = aSample.xy;
        float travel = 0.65 + (aSample.z - 0.5) * uRelief;
        vec2 point = uOrigin + uRotation * (vUv * uSize) + uShift * travel;
        vec2 ndc = point / uHeroSize * vec2(2.0, -2.0) + vec2(-1.0, 1.0);
        gl_Position = vec4(ndc, 0.0, 1.0);
      }`);
    attachShader(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform sampler2D uPortrait;
      in vec2 vUv;
      out vec4 color;
      void main() {
        color = texture(uPortrait, vUv);
        if (color.a < 0.004) discard;
      }`);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'Could not link the portrait shaders');
    }
    gl.useProgram(program);
    const heroSize = gl.getUniformLocation(program, 'uHeroSize');
    const origin = gl.getUniformLocation(program, 'uOrigin');
    const size = gl.getUniformLocation(program, 'uSize');
    const rotation = gl.getUniformLocation(program, 'uRotation');
    const shift = gl.getUniformLocation(program, 'uShift');
    const relief = gl.getUniformLocation(program, 'uRelief');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const layers = sources.map(bindPortrait);
    let layoutWidth;
    let layoutHeight;
    let placements;

    return (width, height, x, y) => {
      const scale = Math.min(devicePixelRatio || 1, 1.5);
      const pixelWidth = Math.max(1, Math.round(width * scale));
      const pixelHeight = Math.max(1, Math.round(height * scale));
      if (portraitCanvas.width !== pixelWidth || portraitCanvas.height !== pixelHeight) {
        portraitCanvas.width = pixelWidth;
        portraitCanvas.height = pixelHeight;
      }
      if (width !== layoutWidth || height !== layoutHeight) {
        layoutWidth = width;
        layoutHeight = height;
        placements = layers.map(({ image, cells }) => {
          const style = getComputedStyle(image);
          const { a, b, c, d } = new DOMMatrixReadOnly(style.transform);
          const imageSize = [parseFloat(style.width), parseFloat(style.height)];
          return {
            origin: [parseFloat(style.left), parseFloat(style.top)],
            size: imageSize,
            rotation: [a, b, c, d],
            depthSlope: cells.map((count, axis) => maxDepthStep / 255 * count / imageSize[axis]),
          };
        });
      }

      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.uniform2f(heroSize, width, height);
      gl.uniform2f(shift, x, y);
      gl.clear(gl.COLOR_BUFFER_BIT);
      layers.forEach(({ mesh, texture, count }, i) => {
        const placement = placements[i];
        const [a, b, c, d] = placement.rotation;
        const [slopeX, slopeY] = placement.depthSlope;
        const projectedSlope = Math.abs(a * x + b * y) * slopeX + Math.abs(c * x + d * y) * slopeY;
        // Keep at least 55% of each triangle's original area, even when scroll and pointer shifts combine.
        gl.uniform1f(relief, Math.min(.7, .45 / projectedSlope));
        gl.uniform2fv(origin, placement.origin);
        gl.uniform2fv(size, placement.size);
        gl.uniformMatrix2fv(rotation, false, placement.rotation);
        gl.bindVertexArray(mesh);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
      });
    };
  }

  function clearPointer() {
    pointer = null;
    requestFrame();
  }

  function resetPointer() {
    pointer = null;
    pointerX = 0;
    pointerY = 0;
    lastFrame = null;
  }

  function updateMotion() {
    if (!motion.matches || document.hidden) {
      resetPointer();
      showPortraitCanvas(false);
    }
    requestFrame();
  }

  portraitCanvas?.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    contextLost = true;
    paintPortraits = null;
    showPortraitCanvas(false);
  });
  portraitCanvas?.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    requestFrame();
  });

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) requestFrame();
    else {
      resetPointer();
      showPortraitCanvas(false);
    }
  });
  observer.observe(hero);

  window.addEventListener('scroll', requestFrame, { passive: true });
  window.addEventListener('resize', requestFrame);
  window.addEventListener('blur', clearPointer);
  document.addEventListener('visibilitychange', updateMotion);
  hero.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !motion.matches) return;
    pointer = { x: event.clientX, y: event.clientY };
    requestFrame();
  });
  hero.addEventListener('pointerleave', clearPointer);
  hero.addEventListener('pointercancel', clearPointer);
  if (motion.addEventListener) motion.addEventListener('change', updateMotion);
  else motion.addListener(updateMotion);
})();
