const express = require('express');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const app = express();
const port = 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Set up multer for handling file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Base URL for the external API
const API_BASE_URL = 'https://a2d9-121-52-146-243.ngrok-free.app';

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/products', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'products.html'));
});

app.get('/mockup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mockup.html'));
});

// New route for image generation
// Updated route for image generation
app.post('/api/generate-image', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'mask', maxCount: 1 }
]), async (req, res) => {
    try {
        // Extract files and form data
        const imageFile = req.files.image[0];
        const maskFile = req.files.mask[0];
        console.log('Files received:', {
            image: imageFile ? imageFile.path : 'none',
            mask: maskFile ? maskFile.path : 'none'
        });



        // Extract other form fields
        const prompt = req.body.prompt || '';
        const checkpoint_name = req.body.checkpoint_name || 'Finetuned_anime.safetensors';
        const negative_prompt = req.body.negative_prompt || 'ugly, deformed, disfigured, poor quality, low quality';
        const width = parseInt(req.body.width) || 1080;
        const height = parseInt(req.body.height) || 1080;
        const steps = parseInt(req.body.steps) || 30;
        const cfg = parseFloat(req.body.cfg) || 9.0;
        const sampler_name = req.body.sampler_name || 'euler_ancestral';
        const scheduler = req.body.scheduler || 'normal';
        const seed = req.body.seed ? parseInt(req.body.seed) : null;

        console.log('API request received with params:', {
            prompt,
            checkpoint_name,
            negative_prompt,
            width,
            height,
            steps,
            cfg,
            sampler_name,
            scheduler,
            seed
        });

        // Create form data to send to external API
        const formData = new FormData();
        formData.append('image', fs.createReadStream(imageFile.path));
        formData.append('mask', fs.createReadStream(maskFile.path));
        formData.append('prompt', prompt);
        formData.append('checkpoint_name', checkpoint_name);
        formData.append('negative_prompt', negative_prompt);
        formData.append('width', width);
        formData.append('height', height);
        formData.append('steps', steps);
        formData.append('cfg', cfg);
        formData.append('sampler_name', sampler_name);
        formData.append('scheduler', scheduler);
        if (seed !== null) {
            formData.append('seed', seed);
        }

        console.log('Sending request to external API');

        // Make request to external API with timeout
        const response = await axios.post(`${API_BASE_URL}/generate/`, formData, {
            headers: {
                ...formData.getHeaders()
            },
            timeout: 120000, // 2 minute timeout for image generation
            maxContentLength: 50 * 1024 * 1024 // Allow larger responses (50MB)
        });

        console.log('Response received from external API:', {
            status: response.status,
            dataSize: response.data ? JSON.stringify(response.data).length : 'unknown',
            hasImages: response.data && response.data.images ? response.data.images.length : 'no images'
        });

        // Check if we got images back
        if (!response.data || !response.data.images || !response.data.images.length) {
            console.error('No images in response:', response.data);
            return res.status(400).json({
                error: 'No images returned from generation API'
            });
        }

        // Return the response from the external API
        res.json(response.data);

    } catch (error) {
        console.error('Error calling external API:', error.response ? {
            status: error.response.status,
            data: error.response.data
        } : error.message);

        res.status(500).json({
            error: 'Error processing your request',
            details: error.message,
            response: error.response ? error.response.data : null
        });
    } finally {
        // Clean up uploaded files
        if (req.files.image && req.files.image[0]) {
            fs.unlink(req.files.image[0].path, err => {
                if (err) console.error('Error deleting image file:', err);
            });
        }
        if (req.files.mask && req.files.mask[0]) {
            fs.unlink(req.files.mask[0].path, err => {
                if (err) console.error('Error deleting mask file:', err);
            });
        }
    }
});