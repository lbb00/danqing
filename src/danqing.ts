import { clone } from 'es-toolkit'
import { Canvas, PencilBrush, type CanvasEvents, Circle } from 'fabric'
import { EraserBrush } from '@erase2d/fabric'

export enum Mode {
  Default = 'Default',
  Pencil = 'Pencil',
  Easer = 'Easer',
}

interface Plugin<T = unknown, C = unknown> {
  name: string
  store: T
  install: (canvas: Canvas) => C
}

function createPlugin<T = undefined, C = undefined>(
  name: string,
  opts: {
    store?: T
    install: (canvas: Canvas, ctx: { store: T }) => C
  }
): Plugin<T> {
  const store = opts.store ? clone(opts.store) : undefined
  return {
    name,
    store,
    install(canvas: Canvas) {
      return opts.install(canvas, { store })
    },
  }
}

export const zoomBoardPlugin = createPlugin('zoom-viewport-plugin', {
  install(canvas) {
    canvas.on('mouse:wheel', function (opt) {
      const deltaY = opt.e.deltaY
      let zoom = canvas.getZoom()
      zoom *= 0.999 ** deltaY
      if (zoom > 5) zoom = 5
      if (zoom < 0.5) zoom = 0.5
      canvas.zoomToPoint({ x: opt.e.offsetX, y: opt.e.offsetY }, zoom)
      opt.e.preventDefault()
      opt.e.stopPropagation()
    })
  },
})

export const moveBoardPlugin = createPlugin('move-viewport-plugin', {
  store: {
    isPanning: false,
    lastPosX: 0,
    lastPosY: 0,
  },
  install(canvas, { store }) {
    canvas.on('mouse:down', function (opt) {
      if (canvas.isDrawingMode) return
      store.isPanning = true
      store.lastPosX = opt.e.clientX
      store.lastPosY = opt.e.clientY
    })

    canvas.on('mouse:move', function (opt) {
      if (!store.isPanning) return
      const e = opt.e
      const vpt = canvas.viewportTransform
      vpt[4] += e.clientX - store.lastPosX
      vpt[5] += e.clientY - store.lastPosY
      canvas.renderAll()
      store.lastPosX = e.clientX
      store.lastPosY = e.clientY
    })

    canvas.on('mouse:up', function () {
      store.isPanning = false
    })
  },
})

export const historyPlugin = createPlugin<{
  history: any[]
  step: number
  process: boolean
}>('history-plugin', {
  store: {
    history: [],
    step: -1,
    process: false,
  },
  install(canvas, { store }) {
    const MAX_HISTORY = 20
    function saveHistory() {
      store.history.push(canvas.toJSON())
      store.step += 1
    }
    saveHistory()
    ;(['object:added', 'object:modified', 'object:removed'] as Array<keyof CanvasEvents>).forEach((eventName) => {
      canvas.on(eventName, function (opt) {
        if (opt.target?.excludeFromExport) return
        if (store.process) return
        if (store.step !== store.history.length - 1) {
          store.history = store.history.slice(0, store.step + 1)
        }
        if (store.history.length >= MAX_HISTORY) {
          store.history.shift()
          store.step -= 1
        }
        store.history.push(canvas.toJSON())
        store.step += 1
      })
    })
    return {
      methods: {
        async undo() {
          if (store.step === 0) return
          store.process = true
          store.step -= 1
          await canvas.loadFromJSON(store.history[store.step])
          canvas.renderAll()
          store.process = false
        },
        async redo() {
          if (store.step === store.history.length - 1) return
          store.process = true
          store.step += 1
          await canvas.loadFromJSON(store.history[store.step])
          canvas.renderAll()
          store.process = false
        },
      },
    }
  },
})

export const drawingPlugin = createPlugin<{
  mode: Mode
  pencil?: PencilBrush
  eraser?: EraserBrush
}>('tools-plugin', {
  store: {
    mode: Mode.Default,
  },
  install(canvas, { store }) {
    const cursorPoint = new Circle({
      radius: 20 / 2,
      fill: 'rgba(255,255,255,0.6)',
      stroke: 'black',
      originX: 'center',
      originY: 'center',
      centeredScaling: true,
      evented: false,
      selectable: false,
      erasable: false,
      visible: false,
      excludeFromExport: true,
    })

    canvas.add(cursorPoint)
    canvas.on('mouse:move', function (opt) {
      if (store.mode !== Mode.Default) {
        if (!canvas.getObjects().includes(cursorPoint)) {
          canvas.add(cursorPoint)
        }
        cursorPoint
          .set({
            top: opt.scenePoint.y,
            left: opt.scenePoint.x,
          })
          .setCoords()
        canvas.renderAll()
      }
    })

    canvas.on('mouse:over', function () {
      if (store.mode === Mode.Default) return
      cursorPoint.visible = true
      canvas.renderAll()
    })

    canvas.on('mouse:out', function () {
      cursorPoint.visible = false
      canvas.renderAll()
    })

    function setMode(newMode: Mode) {
      store.mode = newMode
      switch (newMode) {
        case Mode.Pencil:
          startPencilMode()
          return
        case Mode.Easer:
          startEaserMode()
          return
        default:
          startDefaultMode()
      }
    }

    function startPencilMode() {
      if (!store.pencil) {
        const pencil = new PencilBrush(canvas)
        pencil.width = 20
        pencil.color = '#fff'
        store.pencil = pencil
      }
      canvas.freeDrawingBrush = store.pencil
      canvas.isDrawingMode = true
    }

    function startEaserMode() {
      if (!store.eraser) {
        const eraser = new EraserBrush(canvas)
        eraser.on('end', (e) => {
          e.preventDefault()
          eraser.commit(e.detail)
        })
        eraser.width = 30
        store.eraser = eraser
      }

      canvas.freeDrawingBrush = store.eraser
      canvas.isDrawingMode = true
    }

    function startDefaultMode() {
      canvas.isDrawingMode = false
      canvas.freeDrawingBrush = undefined
      cursorPoint.visible = false
    }

    return {
      methods: {
        setMode,
      },
    }
  },
})

export function createDrawingBoard() {
  const plugins: Plugin[] = []
  let canvas: Canvas | undefined = undefined

  const drawingBoard = {
    init,
    use,

    getCanvas: () => canvas,
  }
  function _installPlugin(plugin: Plugin) {
    if (!canvas) return
    const res = plugin.install(canvas)
    if (res?.methods) {
      Object.keys(res.methods).forEach((key) => {
        drawingBoard[key] = res.methods[key]
      })
    }
  }

  function init(canvasElement: HTMLCanvasElement) {
    canvas = new Canvas(canvasElement, {
      selection: false,
      width: canvasElement.clientWidth,
      height: canvasElement.clientHeight,
    })

    plugins.forEach(_installPlugin)
    canvas.on('path:created', function (opts) {
      if (!canvas?.isDrawingMode) return
      opts.path.erasable = true
      opts.path.selectable = false
    })

    return drawingBoard
  }

  function use(plugin: Plugin) {
    plugins.push(plugin)
    _installPlugin(plugin)
    return drawingBoard
  }

  return drawingBoard
}
