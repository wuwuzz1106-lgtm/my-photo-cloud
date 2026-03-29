const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());
app.use(express.json()); 

// ================= 1. 雲端金鑰設定 =================
cloudinary.config({ 
  cloud_name: process.env.CLOUD_NAME, 
  api_key: process.env.API_KEY, 
  api_secret: process.env.API_SECRET 
});

// 🚨 請確認 Render 環境變數有設定 MONGODB_URI，或是直接把字串貼在 || 後面的引號內
const MONGODB_URI = 'mongodb://wuwuzz1106_user:h5aOHmajgRJ23xwb@ac-nzd1oia-shard-00-00.q4ya0zb.mongodb.net:27017,ac-nzd1oia-shard-00-01.q4ya0zb.mongodb.net:27017,ac-nzd1oia-shard-00-02.q4ya0zb.mongodb.net:27017/myPhotoCloud?ssl=true&replicaSet=atlas-8ik85g-shard-0&authSource=admin&appName=wuzzw';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ 成功連線至 MongoDB 雲端資料庫！'))
  .catch(err => console.error('❌ MongoDB 連線失敗:', err));

// ================= 2. 資料庫綱要定義 =================
const photoSchema = new mongoose.Schema({
    thumb: String, full: String, filename: String, uploadDate: String, exif: String, public_id: String
});
const albumSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    photos: [photoSchema]
});
const Album = mongoose.model('Album', albumSchema);

app.use(express.static(__dirname));

// ================= 3. Cloudinary 上傳引擎 =================
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const albumName = req.body.album || '未分類';
    return {
      folder: `WU_WU_Cloud/${albumName.replace(/[\\/:*?"<>|]/g, "_")}`,
      format: 'jpg',
      public_id: Date.now() + '-' + file.originalname.split('.')[0],
    };
  },
});
const upload = multer({ storage: storage });

// ================= 4. API 路由區 =================

// 取得所有相簿與照片
app.get('/api/data', async (req, res) => {
    try {
        const albums = await Album.find();
        const data = {};
        albums.forEach(a => { data[a.name] = a.photos; });
        res.json(data);
    } catch (error) { res.status(500).json({ error: '讀取資料庫失敗' }); }
});

// 建立空白新相簿 (已修復補回)
app.post('/api/albums', async (req, res) => {
    try {
        const { albumName } = req.body;
        const existingAlbum = await Album.findOne({ name: albumName });
        if (existingAlbum) return res.status(400).json({ error: '相簿已存在' });
        
        await Album.create({ name: albumName, photos: [] });
        res.json({ message: '相簿建立成功' });
    } catch (error) { res.status(500).json({ error: '建立相簿失敗' }); }
});

// 上傳照片
app.post('/api/upload', upload.array('photos'), async (req, res) => {
    try {
        const albumName = req.body.album || '未分類';
        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ error: '沒收到照片' });

        const today = new Date();
        const uploadedPhotos = files.map(file => ({
            thumb: file.path, full: file.path, filename: file.originalname,
            uploadDate: `${today.getMonth() + 1}月 ${today.getDate()}, ${today.getFullYear()}`,
            exif: 'Cloudinary 雲端', public_id: file.filename 
        }));

        await Album.findOneAndUpdate(
            { name: albumName }, { $push: { photos: { $each: uploadedPhotos } } }, { upsert: true, new: true }
        );
        res.json({ message: '上傳成功！', photos: uploadedPhotos });
    } catch (error) { res.status(500).json({ error: '上傳失敗' }); }
});

// 相簿改名
app.put('/api/album/rename', async (req, res) => {
    try {
        const { oldName, newName } = req.body;
        const existing = await Album.findOne({ name: newName });
        if (existing) return res.status(400).json({ error: '這個名稱已經有人用了喔！' });

        const album = await Album.findOneAndUpdate({ name: oldName }, { name: newName }, { new: true });
        if (!album) return res.status(404).json({ error: '找不到相簿' });
        res.json({ message: '改名成功' });
    } catch (error) { res.status(500).json({ error: '改名失敗' }); }
});

// 批次刪除照片
app.post('/api/photos/batch-delete', async (req, res) => {
    try {
        const { albumName, photoUrls } = req.body;
        const album = await Album.findOne({ name: albumName });
        if (!album) return res.status(404).json({ error: '找不到相簿' });

        const photosToDelete = album.photos.filter(p => photoUrls.includes(p.full));
        
        // 平行處理刪除 Cloudinary 檔案
        await Promise.all(photosToDelete.map(async (p) => {
            if (p.public_id) await cloudinary.uploader.destroy(p.public_id);
        }));

        album.photos = album.photos.filter(p => !photoUrls.includes(p.full));
        await album.save();

        res.json({ message: `成功刪除了 ${photosToDelete.length} 張照片` });
    } catch (error) { res.status(500).json({ error: '批次刪除照片失敗' }); }
});

// 批次刪除相簿
app.post('/api/albums/batch-delete', async (req, res) => {
    try {
        const { albumNames } = req.body;
        
        for (const name of albumNames) {
            const album = await Album.findOneAndDelete({ name });
            if (album) {
                await Promise.all(album.photos.map(async (p) => {
                    if (p.public_id) await cloudinary.uploader.destroy(p.public_id);
                }));
            }
        }
        res.json({ message: `成功刪除了 ${albumNames.length} 本相簿` });
    } catch (error) { res.status(500).json({ error: '批次刪除相簿失敗' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`🚀 雲端伺服器已啟動在 port ${PORT}`); });