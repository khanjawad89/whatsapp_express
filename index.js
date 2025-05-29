const express = require('express');
const { Client, MessageMedia  } = require('whatsapp-web.js');
const cors = require('cors');
const app = express();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
app.use(cors());
app.use(express.json({ limit: '50mb', type: 'application/json' }));
app.use(express.urlencoded({ extended: true }));
app.listen(3000, () => console.log('Express Server running on port 3000'));
app.use('/media', express.static(path.join(__dirname, 'media')));

const clients = new Map(); // Store multiple clients
const qrCodes = new Map(); // Store QR codes
const clientStatus = new Map(); // Store client status
const failureTimeouts = {};
const STATUS_WEBHOOK_URL = 'http://127.0.0.1:8000/api/v1/whatsapp/status';
const mimeExtensions = {
    'image/jpeg': '.jpeg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'audio/mp4': '.m4a', 'application/pdf': '.pdf', 'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.ms-powerpoint': '.ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
    'application/zip': '.zip', 'video/mp4': '.mp4', 'video/x-msvideo': '.avi', 'video/quicktime': '.mov',
    'video/webm': '.webm', 'video/x-flv': '.flv', 'application/rtf': '.rtf', 'text/plain': '.txt',
    'application/json': '.json', 'application/xml': '.xml','audio/ogg; codecs=opus': '.ogg'
};


// Start WhatsApp session for a user
app.post('/start-client', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (clients.has(userId)) {
        const client = clients.get(userId);
        const status = clientStatus.get(userId);
        
        if (status === 'READY') {
            return res.json({ message: 'Client already authenticated', status: 'READY' });
        }
        if (status === 'INITIALIZING') {
            return res.json({ message: 'Client is initializing', status: 'INITIALIZING' });
        }
    }

    const client = new Client({
        puppeteer: { headless: true },
    });
    
    clients.set(userId, client);
    clientStatus.set(userId, 'INITIALIZING');
    qrCodes.delete(userId); // Clear any existing QR code

    client.on('qr', (qr) => {
        // Only log and store QR if client is still in initializing state
        const currentStatus = clientStatus.get(userId);
        if (currentStatus === 'INITIALIZING') {
            console.log(`QR Code generated for ${userId}`);
            qrCodes.set(userId, qr);
        } else {
            console.log(`QR Code ignored for ${userId} - Status: ${currentStatus}`);
        }
    });

    client.on('ready', () => {
        console.log(`WhatsApp Client ${userId} is ready`);
        clientStatus.set(userId, 'READY');
        qrCodes.delete(userId); // Clear QR code when ready
		setupClientEventListeners(client);
    });

    client.on('authenticated', () => {
        console.log(`WhatsApp Client ${userId} is authenticated`);
        clientStatus.set(userId, 'AUTHENTICATED');
        qrCodes.delete(userId); // Clear QR code when authenticated
    });

    client.on('auth_failure', () => {
        console.log(`Authentication failed for ${userId}`);
        clientStatus.set(userId, 'AUTH_FAILURE');
        qrCodes.delete(userId);
    });

    client.on('disconnected', (reason) => {
        console.log(`Client ${userId} disconnected:`, reason);
        clientStatus.set(userId, 'DISCONNECTED');
        clients.delete(userId);
        qrCodes.delete(userId);
    });
	

    client.initialize();
    return res.json({ message: 'Initializing WhatsApp client', status: 'INITIALIZING' });
});

// Get QR code for user
app.get('/get-qr/:userId', (req, res) => {
    const { userId } = req.params;
    const status = clientStatus.get(userId);
    
    // Don't return QR if already authenticated or ready
    if (status === 'READY' || status === 'AUTHENTICATED') {
        return res.json({ status: 'already_connected', message: 'WhatsApp is already connected' });
    }
    
    const qr = qrCodes.get(userId);
    if (!qr) {
        return res.status(404).json({ error: 'QR code not found or expired' });
    }
    
    return res.json({ status: 'success', qr });
});

// Check connection status
app.get('/is-connected/:userId', (req, res) => {
	console.log("status called ");
    const { userId } = req.params;
    const client = clients.get(userId);
    const status = clientStatus.get(userId);
	console.log(status);
    
    if (!client) {
        return res.json({ status: 'not_found', connected: false });
    }
    
    if (status === 'READY' && client.info?.wid) {
        return res.json({ 
            status: 'connected', 
            connected: true,
            user: client.info.wid._serialized || client.info.wid 
        });
    } else if (status === 'INITIALIZING') {
        return res.json({ status: 'initializing', connected: false });
    } else {
        return res.json({ status: 'not_connected', connected: false });
    }
});


// Get client status
app.get('/client-status/:userId', (req, res) => {
    const { userId } = req.params;
    const status = clientStatus.get(userId);
    return res.json({ status: status || 'not_found' });
});

// Stop/Logout WhatsApp client for a user
app.post('/stop-client', async (req, res) => {
	console.log("logout triggered in express");
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    
    const client = clients.get(userId);
    if (!client) {
        return res.status(404).json({ error: 'Client not found' });
    }
    
    try {
        console.log(`Stopping WhatsApp client for user: ${userId}`);
        
        // Logout the client
        await client.logout();
        
        // Destroy the client
        await client.destroy();
        
        // Clean up all data for this user
        clients.delete(userId);
        qrCodes.delete(userId);
        clientStatus.delete(userId);
        console.log(`WhatsApp client ${userId} stopped and cleaned up`);
        return res.json({ message: 'Client stopped successfully', status: 'STOPPED' });
        
    } catch (error) {
        console.error(`Error stopping client ${userId}:`, error);
        clients.delete(userId);
        qrCodes.delete(userId);
        clientStatus.delete(userId);
        
        return res.json({ message: 'Client force stopped', status: 'FORCE_STOPPED' });
    }
});

// Get all active clients (for debugging)
app.get('/active-clients', (req, res) => {
    const activeClients = Array.from(clients.keys()).map(userId => ({
        userId,
        status: clientStatus.get(userId),
        hasQrCode: qrCodes.has(userId)
    }));
    
    return res.json({ 
        total: activeClients.length, 
        clients: activeClients 
    });
});

// Cleanup inactive clients (run periodically)
const cleanupInactiveClients = () => {
    console.log('Running cleanup for inactive clients...');
    
    clients.forEach(async (client, userId) => {
        try {
            // Check if client is still responsive
            const state = await client.getState();
            if (!state || state === 'CONFLICT' || state === 'UNPAIRED') {
                console.log(`Cleaning up inactive client: ${userId}`);
                
                try {
                    await client.destroy();
                } catch (e) {
                    console.error(`Error destroying client ${userId}:`, e);
                }
                
                clients.delete(userId);
                qrCodes.delete(userId);
                clientStatus.delete(userId);
            }
        } catch (error) {
            console.log(`Client ${userId} is unresponsive, cleaning up...`);
            
            try {
                await client.destroy();
            } catch (e) {
                console.error(`Error destroying unresponsive client ${userId}:`, e);
            }
            
            clients.delete(userId);
            qrCodes.delete(userId);
            clientStatus.delete(userId);
        }
    });
};

// Run cleanup every 5 minutes
setInterval(cleanupInactiveClients, 5 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    
    // Cleanup all clients
    const cleanupPromises = Array.from(clients.entries()).map(async ([userId, client]) => {
        try {
            console.log(`Cleaning up client ${userId}...`);
            await client.logout();
            await client.destroy();
        } catch (error) {
            console.error(`Error cleaning up client ${userId}:`, error);
        }
    });
    
    await Promise.all(cleanupPromises);
    console.log('All clients cleaned up. Exiting...');
    process.exit(0);
});


// Send message
app.post('/send-message', async (req, res) => {
    console.log("Incoming request data:", req.body);
    const { userId, phoneNumber, message, mediaUrl } = req.body;
    const normalizedUserId = String(userId);
    const client = clients.get(normalizedUserId);
    const status = clientStatus.get(userId);
    
    if (!client) {
        return res.status(404).json({ error: 'Client not found' });
    }
    
    if (status !== 'READY' || !client.info?.wid) {
        return res.status(400).json({ error: 'WhatsApp is not connected' });
    }
    
    if (!phoneNumber || phoneNumber.length < 10) {
        return res.status(400).json({ error: "Invalid phone number format" });
    }
    
    try {
        const formattedNumber = phoneNumber.startsWith('+') ? phoneNumber.slice(1) : phoneNumber;

        let sentMessage;
        let fullId;
        let messageSid;

        if (mediaUrl) {
            try {
                console.log(`Fetching media from: ${mediaUrl}`);
                const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
                sentMessage = await client.sendMessage(`${formattedNumber}@c.us`, media);
                fullId = sentMessage.id._serialized; 
                console.log(fullId);
                messageSid = fullId.split('_').pop();
                console.log(messageSid);
                
                // Send status update asynchronously
                sendStatusUpdate(messageSid, 'sent').catch(err => 
                    console.error('Failed to send status update:', err)
                );
            } catch (error) {
                console.error("Error fetching media:", error);
                if (messageSid) {
                    sendStatusUpdate(messageSid, 'failed', 30008).catch(err => 
                        console.error('Failed to send error status:', err)
                    );
                }
                return res.status(500).json({ error: "Failed to fetch media file" });
            }
        } else {
            sentMessage = await client.sendMessage(`${formattedNumber}@c.us`, message);
            fullId = sentMessage.id._serialized; 
            console.log(fullId);
            messageSid = fullId.split('_').pop();
            console.log(messageSid);
            
            // Send status update asynchronously
            sendStatusUpdate(messageSid, 'sent').catch(err => 
                console.error('Failed to send status update:', err)
            );
        }
        
        return res.json({ 
            status: 'message_sent', 
            to: phoneNumber, 
            message, 
            mediaUrl, 
            messageSid: messageSid || fullId
        });

    } catch (error) {
        console.error("Error sending message:", error);
        if (messageSid) {
            sendStatusUpdate(messageSid, 'failed', 30007).catch(err => 
                console.error('Failed to send error status:', err)
            );
        }
        return res.status(500).json({ error: "Failed to send message" });
    }
});

// Function to setup event listeners for a specific client
function setupClientEventListeners(client, userId) {
	//receiving new messages 
	 client.on('message', async (msg) => {
		try {
			let mediaUrl = null;
			let mediaType = null;
			let normalizedMimeType = null;
			let MessageType = null;
			
			if (msg.hasMedia) {
				const media = await msg.downloadMedia();
				mediaType = media.mimetype;  
				console.log(mediaType);
				normalizedMimeType = media.mimetype.split(';')[0].trim();  
				console.log(normalizedMimeType);
				const extension = mimeExtensions[normalizedMimeType] || '.bin';
				const filePath = path.join(__dirname, 'media', `${Date.now()}${extension}`);
				fs.writeFileSync(filePath, media.data, 'base64');
				mediaUrl = `http://127.0.0.1:3000/media/${path.basename(filePath)}`;
				if(msg.type == 'ptt'){
					MessageType = 'audio';					
				} else {
					MessageType = msg.type;
				}

			}
			
			const webhookData = {
				From: msg.from,
				To: client.info.wid._serialized,
				MessageSid: msg.id._serialized,
				Body: msg.body ?? '',
				MessageType: MessageType,
				MediaUrl0: mediaUrl,
				MediaContentType0: normalizedMimeType ?? 'unknown',
			};
			
			await axios.post('http://127.0.0.1:8000/api/v1/whatsapp', webhookData, {
				headers: {
					'Content-Type': 'application/json'
				}
			});
		}catch (error) {
            console.error(`Error forwarding message for user ${userId}:`, error);
        }
    });
	
	//checkign status 
   client.on('message_ack', async (msg, ack) => {
    console.log("Received ACK:", { id: msg.id._serialized, ack });

    const fullId = msg.id._serialized;
    const messageSid = fullId.split('_').pop();
    
    let status;
    switch (ack) {
        case 1: status = 'sent'; break;  
        case 2: status = 'delivered'; break;  
        case 3: status = 'read'; break;  
        default: return;
    }

    console.log(`Updating status for ${messageSid}: ${status}`);
    sendStatusUpdate(messageSid, status).catch(err => 
        console.error('Failed to send status update:', err)
    );

    // Cancel the failure timeout if status is updated
    if (failureTimeouts[messageSid]) {
        clearTimeout(failureTimeouts[messageSid]);
        delete failureTimeouts[messageSid]; // Clean up memory
        console.log(`Cleared timeout for message: ${messageSid}`);
    }
});




    // Listen for message send failures
client.on('message_create', async (msg) => {
    if (msg.fromMe) {
        try {
            const msgSid = msg.id._serialized.split('_').pop();

            // Start a timeout to check if the message was sent successfully
            failureTimeouts[msgSid] = setTimeout(async () => {
                if (msg.ack === undefined || msg.ack === 0) {
                    console.log(`Message ${msgSid} still not delivered—marking as failed`);
                    sendStatusUpdate(msgSid, 'failed', 30008).catch(err => 
                        console.error('Failed to send error status:', err)
                    );
                } else {
                    console.log(`Message ${msgSid} was acknowledged—no failure status needed`);
                }
            }, 20000); // 20-second timeout

        } catch (error) {
            console.error('Error checking message status:', error);
        }
    }
});


}

// Call this function when each client is ready
// Add this to your existing client initialization code:
// setupClientEventListeners(client, userId);

// Message status update function
async function sendStatusUpdate(messageSid, status, errorCode = null) {
    try {
        const payload = {
            MessageSid: messageSid, // Change to 'sid' if your Laravel uses 'sid'
            MessageStatus: status
        };
        
        if (errorCode) {
            payload.ErrorCode = errorCode;
        }
        
        await axios.post(STATUS_WEBHOOK_URL, payload);
        console.log('Status update sent:', { messageSid, status, errorCode });
    } catch (error) {
        console.error('Failed to send status update:', error.message);
    }
}
