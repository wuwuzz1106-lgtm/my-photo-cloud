const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

// ☁️ 雲端套件：Mongoose (資料庫) + Cloudinary (圖片空間)
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
app.use(cors());
app.use(express.json());

// ========================================================
// 1. 雲端金鑰設定區
// ========================================================
// 🛑 請在這裡補上你的 Cloudinary 金鑰 (保留單引號)
cloudinary.config({ 
  cloud_name: process.env.CLOUD_NAME, 
  api_key: process.env.API_KEY, 
  api_secret: process.env.API_SECRET 
});

// ✅ 你的 MongoDB 專屬連線字串 (加上了資料庫名稱 myPhotoCloud)
const MONGODB_URI = 'mongodb://wuwuzz1106_user:h5aOHmajgRJ23xwb@ac-nzd1oia-shard-00-00.q4ya0zb.mongodb.net:27017,ac-nzd1oia-shard-00-01.q4ya0zb.mongodb.net:27017,ac-nzd1oia-shard-00-02.q4ya0zb.mongodb.net:27017/myPhotoCloud?ssl=true&replicaSet=atlas-8ik85g-shard-0&authSource=admin&appName=wuzzw';

// 啟動 MongoDB 連線
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ 成功連線至 MongoDB 雲端資料庫！'))
  .catch(err => console.error('❌ MongoDB 連線失敗:', err));

// ========================================================
// 2. 資料庫綱要 (Schema) 定義
// ========================================================
// 告訴 MongoDB 我們的照片長什麼樣子
const photoSchema = new mongoose.Schema({
    thumb: String,
    full: String,
    filename: String,
    uploadDate: String,
    exif: String,
    downloadable: Boolean,
    pro: Boolean,
    public_id: String // 刪除雲端檔案必備的鑰匙
});

// 告訴 MongoDB 我們的相簿長什麼樣子
const albumSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    photos: [photoSchema]
});

const Album = mongoose.model('Album', albumSchema);

app.use(express.static(__dirname)); 

// ========================================================
// 3. 雲端上傳引擎 (Cloudinary)
// ========================================================
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const albumName = req.body.album || '未分類';
    const safeAlbumName = albumName.replace(/[\\/:*?"<>|]/g, "_");
    return {
      folder: `WU_WU_Cloud/${safeAlbumName}`,
      format: 'jpg',
      public_id: Date.now() + '-' + file.originalname.split('.')[0],
    };
  },
});
const upload = multer({ storage: storage });

// ========================================================
// 4. API 路由 (全雲端化)
// ========================================================

// 取得所有相簿 (為了不讓完美的前端壞掉，這裡把資料轉成它熟悉的格式)
app.get('/api/data', async (req, res) => {
    try {
        const albums = await Album.find();
        const data = {};
        albums.forEach(a => { data[a.name] = a.photos; });
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: '讀取資料庫失敗' });
    }
});

// 建立新相簿
app.post('/api/albums', async (req, res) => {
    try {
        const { albumName } = req.body;
        const existingAlbum = await Album.findOne({ name: albumName });
        if (existingAlbum) return res.status(400).json({ error: '相簿已存在' });
        
        await Album.create({ name: albumName, photos: [] });
        res.json({ message: '相簿建立成功' });
    } catch (error) {
        res.status(500).json({ error: '建立相簿失敗' });
    }
});

// 上傳照片 (同時寫入 MongoDB 與 Cloudinary)
app.post('/api/upload', upload.array('photos'), async (req, res) => {
    try {
        const albumName = req.body.album || '未分類';
        const files = req.files;
        if (!files || files.length === 0) return res.status(400).json({ error: '沒收到照片' });

        const today = new Date();
        const dateString = `${today.getMonth() + 1}月 ${today.getDate()}, ${today.getFullYear()}`;

        const uploadedPhotos = files.map(file => ({
            thumb: file.path, 
            full: file.path,
            filename: file.originalname,
            uploadDate: dateString,
            exif: 'Cloudinary 雲端',
            downloadable: true,
            pro: false,
            public_id: file.filename 
        }));

        // 找尋相簿並把新照片塞進去，如果相簿不存在就自動建一個
        await Album.findOneAndUpdate(
            { name: albumName },
            { $push: { photos: { $each: uploadedPhotos } } },
            { upsert: true, new: true }
        );

        console.log(`✅ 成功上傳 ${files.length} 張照片至雲端相簿：${albumName}`);
        res.json({ message: '上傳成功！', photos: uploadedPhotos });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: '上傳失敗' });
    }
});

// 刪除單張照片
app.delete('/api/photo', async (req, res) => {
    try {
        const { albumName, photoUrl } = req.body;
        const album = await Album.findOne({ name: albumName });

        if (album) {
            const photoToDelete = album.photos.find(p => p.full === photoUrl);
            if (photoToDelete) {
                // 1. 從 MongoDB 抹除記憶
                album.photos = album.photos.filter(p => p.full !== photoUrl);
                await album.save();

                // 2. 從 Cloudinary 刪除真實檔案
                if (photoToDelete.public_id) {
                    await cloudinary.uploader.destroy(photoToDelete.public_id);
                    console.log(`🗑️ 雲端實體檔案已刪除: ${photoToDelete.public_id}`);
                }
                return res.json({ message: '照片已刪除' });
            }
        }
        res.status(404).json({ error: '找不到照片' });
    } catch (error) {
        res.status(500).json({ error: '刪除失敗' });
    }
});

// 刪除整本相簿
app.delete('/api/album', async (req, res) => {
    try {
        const { albumName } = req.body;
        const album = await Album.findOneAndDelete({ name: albumName });

        if (album) {
            // 批次刪除 Cloudinary 上的真實檔案
            for (const photo of album.photos) {
                if (photo.public_id) await cloudinary.uploader.destroy(photo.public_id);
            }
            console.log(`🗑️ 雲端相簿 [${albumName}] 內的檔案已全數清除`);
            return res.json({ message: '相簿已刪除' });
        }
        res.status(404).json({ error: '找不到相簿' });
    } catch (error) {
        res.status(500).json({ error: '刪除相簿失敗' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 雲端伺服器已啟動在 port ${PORT}`);
});