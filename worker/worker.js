const io = require('socket.io');
const ioClient = require('socket.io-client');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const path = require('path');

class Worker {
  constructor(port, trackerAddress) {
    this.port = port;
    this.server = io(port);
    this.trackerSocket = ioClient(trackerAddress);
    this.chunks = new Map();
    this.files = new Map(); // TODO: move to tracker
    this.setupEventListeners();
    console.log(`Worker started on port ${port}`);
  }

  setupEventListeners() {
    this.server.on('connection', (socket) => {
      console.log(`New connection on port ${this.port}`);

      socket.on('store_chunk', (data, callback) => {
        this.storeChunk(data.fileId, data.chunkId, data.chunk);
        this.trackerSocket.emit('store_chunk_info', {
          fileId: data.fileId,
          chunkId: data.chunkId
        });
        callback({ success: true });
      });

      socket.on('retrieve_chunk', (data, callback) => {
        const chunk = this.retrieveChunk(data.fileId, data.chunkId);
        callback(chunk);
      });
    });

    this.trackerSocket.on('connect', () => {
      this.trackerSocket.emit('register_worker', {
        address: 'localhost',
        port: this.port
      });
    });
  }

  storeChunk(fileId, chunkId, chunk) {
    if (!this.chunks.has(fileId)) {
      this.chunks.set(fileId, new Map());
    }
    this.chunks.get(fileId).set(chunkId, chunk);
    console.log(`Stored chunk ${chunkId} of file ${fileId}`);
  }

  retrieveChunk(fileId, chunkId) {
    if (this.chunks.has(fileId) && this.chunks.get(fileId).has(chunkId)) {
      return this.chunks.get(fileId).get(chunkId);
    }
    return null;
  }

  async uploadFile(filePath) {
    const fileContent = fs.readFileSync(filePath);
    const fileId = crypto.randomBytes(16).toString('hex');
    const chunks = this.splitIntoChunks(fileContent);

    // Store the uploaded file information
    this.files.set(fileId, {
      fileName: path.basename(filePath),
      fileSize: fileContent.length
    });

    const activeWorkers = await this.getActiveWorkers();
    const replicationFactor = Math.ceil(activeWorkers.length / 2);

    for (let i = 0; i < chunks.length; i++) {
      const targetWorkers = this.selectRandomWorkers(activeWorkers, replicationFactor);
      for (const worker of targetWorkers) {
        const workerSocket = ioClient(`http://${worker.address}:${worker.port}`);
        await new Promise((resolve) => {
          workerSocket.emit('store_chunk', {
            fileId,
            chunkId: i,
            chunk: chunks[i]
          }, (response) => {
            if (response.success) {
              resolve();
            }
          });
        });
      }
    }
 

    console.log(`File uploaded with ID: ${fileId}`);
    return fileId;
  }

  async getActiveWorkers() {
    return new Promise((resolve) => {
      this.trackerSocket.emit('get_active_workers', (workers) => {
        resolve(workers);
      });
    });
  }

  selectRandomWorkers(workers, count) {
    const shuffled = workers.slice().sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }

  async downloadFile(fileId, outputPath) {
    const chunks = [];
    const fileChunks = await this.getFileChunks(fileId);
  
    for (const chunkId of fileChunks) {
      const locations = await this.getChunkLocations(fileId, chunkId);
      if (locations.length === 0) {
        console.error(`Chunk ${chunkId} of file ${fileId} not found`);
        return;
      }
      console.log("trying to retrieve chunk");
      // Attempt to retrieve the chunk from the first available location
      const chunk = await new Promise((resolve) => {
        const nodeSocket = ioClient(`http://${locations[0].address}:${locations[0].port}`);
        nodeSocket.emit('retrieve_chunk', { fileId, chunkId }, (chunk) => {
          resolve(chunk);
        });
      });
  
      // Store the retrieved chunk in the correct position
      chunks[chunkId] = chunk;
    }
  
    // Filter out any undefined chunks
    const validChunks = chunks.filter(Boolean);
    
    if (validChunks.length === 0) {
      console.error('No valid chunks retrieved for the file.');
      return;
    }
  
    // Concatenate the chunks into a single buffer
    const fileContent = Buffer.concat(validChunks);
    fs.writeFileSync(outputPath, fileContent);
    console.log(`File downloaded to ${outputPath}`);
    this.verifyFileIntegrity(fileContent, fileId);
  }

  splitIntoChunks(buffer) {
    const chunks = [];
    const chunkSize = 512;
    for (let i = 0; i < buffer.length; i += chunkSize) {
      chunks.push(buffer.slice(i, i + chunkSize));
    }
    return chunks;
  }

  verifyFileIntegrity(fileContent, fileId) {
    const hash = crypto.createHash('sha256').update(fileContent).digest('hex');
    console.log(`File integrity check:
      File ID: ${fileId}
      SHA-256 Hash: ${hash}
    `);
  }

  getActiveNodes() {
    return new Promise((resolve) => {
      this.trackerSocket.emit('get_active_nodes', (nodes) => {
        resolve(nodes);
      });
    });
  }

  getChunkLocations(fileId, chunkId) {
    return new Promise((resolve) => {
      this.trackerSocket.emit('get_chunk_locations', { fileId, chunkId }, (locations) => {
        resolve(locations);
      });
    });
  }

  getFileChunks(fileId) {
    return new Promise((resolve) => {
      this.trackerSocket.emit('get_file_chunks', fileId, (chunks) => {
        resolve(chunks);
      });
    });
  }

  selectRandomNodes(nodes, count) {
    const shuffled = nodes.sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }

  listStoredChunks() {
    console.log('Stored chunks:');
    this.chunks.forEach((fileChunks, fileId) => {
      console.log(`File ID: ${fileId}`);
      fileChunks.forEach((chunk, chunkId) => {
        console.log(`  Chunk ID: ${chunkId}, Size: ${chunk.length} bytes`);
      });
    });
  }


  listStoredFiles() {
    console.log('Stored files:');
    this.files.forEach((fileInfo, fileId) => {
      console.log(`File ID: ${fileId}, Name: ${fileInfo.fileName}, Size: ${fileInfo.fileSize} bytes`);
    });
  }

  cli() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    console.log(`Worker CLI (Port ${this.port}):`);
    console.log('Available commands:');
    console.log('- upload <file_path>: Upload a file');
    console.log('- download <file_id> <output_path>: Download a file');
    console.log('- list_chunks: List all stored chunks');
    console.log('- list_files: List all stored files');
    console.log('- exit: Exit the worker');

    rl.on('line', async (input) => {
      const [command, ...args] = input.trim().split(' ');

      switch (command) {
        case 'upload':
          if (args.length !== 1) {
            console.log('Usage: upload <file_path>');
            break;
          }
          try {
            const fileId = await this.uploadFile(args[0]);
            console.log(`File uploaded. ID: ${fileId}`);
          } catch (error) {
            console.error('Error uploading file:', error.message);
          }
          break;
        case 'download':
          if (args.length !== 2) {
            console.log('Usage: download <file_id> <output_path>');
            break;
          }
          try {
            await this.downloadFile(args[0], args[1]);
          } catch (error) {
            console.error('Error downloading file:', error.message);
          }
          break;
        case 'list_chunks':
          this.listStoredChunks();
          break;
        case 'list_files':
          this.listStoredFiles();
          break;
        case 'exit':
          console.log('Exiting worker...');
          process.exit(0);
        default:
          console.log('Unknown command. Available commands: upload, download, list_chunks, list_files, exit');
      }

      rl.prompt();
    });

    rl.prompt();
  }

}

// Create and start the worker
const port = process.argv[2] || 3001; 
const trackerAddress = 'http://localhost:3000'; 
const worker = new Worker(port, trackerAddress);
worker.cli();
