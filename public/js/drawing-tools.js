// Drawing tools state
let currentTool = null;
let isDrawing = false;
let ctx = null;

// Initialize drawing tools and canvas
document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('drawingCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const brushBtn = document.querySelector('.brush-btn');
    const eraserBtn = document.querySelector('.eraser-btn');
    const clearBtn = document.querySelector('.clear-btn');
    const brushSize = document.getElementById('brushSize');

    let isDrawing = false;
    let currentTool = null;

    // Initial canvas setup
    setupCanvas();
    window.addEventListener('resize', setupCanvas);

    function setupCanvas() {
        const canvasContainer = document.querySelector('.canvas-container');
        if (!canvasContainer || !canvas) return;

        const containerRect = canvasContainer.getBoundingClientRect();
        canvas.width = containerRect.width;
        canvas.height = containerRect.height;

        // Reset context after resize
        setupDrawingContext();
    }

    function setupDrawingContext() {
        if (currentTool === 'brush') {
            ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
            ctx.fillStyle = 'rgba(99, 102, 241, 0.3)';
        } else if (currentTool === 'eraser') {
            ctx.strokeStyle = 'white';
            ctx.fillStyle = 'white';
        }
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = brushSize.value;
    }

    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY
        };
    }

    function startDrawing(e) {
        if (!currentTool) return;
        isDrawing = true;
        const pos = getMousePos(e);
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y);
    }

    function draw(e) {
        if (!isDrawing || !currentTool) return;
        const pos = getMousePos(e);
        ctx.lineTo(pos.x, pos.y);
        ctx.stroke();
    }

    function stopDrawing() {
        isDrawing = false;
        ctx.closePath();
    }

    // Tool selection handlers
    brushBtn.addEventListener('click', () => {
        if (currentTool === 'brush') {
            currentTool = null;
            brushBtn.classList.remove('active');
            canvas.style.cursor = 'default';
        } else {
            currentTool = 'brush';
            brushBtn.classList.add('active');
            eraserBtn.classList.remove('active');
            canvas.style.cursor = 'crosshair';
        }
        setupDrawingContext();
    });

    eraserBtn.addEventListener('click', () => {
        if (currentTool === 'eraser') {
            currentTool = null;
            eraserBtn.classList.remove('active');
            canvas.style.cursor = 'default';
        } else {
            currentTool = 'eraser';
            eraserBtn.classList.add('active');
            brushBtn.classList.remove('active');
            canvas.style.cursor = 'crosshair';
        }
        setupDrawingContext();
    });

    clearBtn.addEventListener('click', () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    });

    brushSize.addEventListener('input', setupDrawingContext);

    // Drawing event listeners
    canvas.addEventListener('mousedown', startDrawing);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', stopDrawing);
    canvas.addEventListener('mouseout', stopDrawing);
}); 