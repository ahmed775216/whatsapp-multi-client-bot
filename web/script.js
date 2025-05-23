document.addEventListener('DOMContentLoaded', () => {
    const ws = new WebSocket('ws://localhost:8088'); // Connect to the manager's existing WebSocket

    const ownerNumberInput = document.getElementById('ownerNumber');
    const setOwnerBtn = document.getElementById('setOwnerBtn');
    const ownerStatus = document.getElementById('ownerStatus');

    const newClientApiUsernameInput = document.getElementById('newClientApiUsername');
    const newClientApiPasswordInput = document.getElementById('newClientApiPassword');
    const linkNewClientBtn = document.getElementById('linkNewClientBtn');
    const linkingStatus = document.getElementById('linkingStatus');
    const qrCodeImg = document.getElementById('qrCodeImg');
    const qrMessage = document.getElementById('qrMessage');

    const refreshClientsBtn = document.getElementById('refreshClientsBtn');
    const clientList = document.getElementById('clientList');

    let currentLinkingClientId = null; // Track the client ID being linked via QR

    // --- WebSocket Event Handlers ---
    ws.onopen = () => {
        console.log('Connected to WebSocket server (Node.js Manager)');
        // Request initial state or client list when connected
        ws.send(JSON.stringify({ type: 'requestInitialState' })); // New request type
    };

    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log('Received from manager:', message);

        switch (message.type) {
            case 'initialState': // Response to requestInitialState
                if (message.ownerNumber) {
                    ownerNumberInput.value = message.ownerNumber;
                    ownerStatus.textContent = `Current Owner: ${message.ownerNumber}`;
                    ownerStatus.style.color = 'green';
                }
                updateClientList(message.activeClients || []);
                break;

            case 'status': // General status updates, including QR
                if (message.qr) {
                    qrCodeImg.src = message.qr;
                    qrCodeImg.style.display = 'block';
                    qrMessage.textContent = message.message;
                    linkingStatus.textContent = ''; // Clear main linking status
                } else {
                    qrCodeImg.style.display = 'none';
                    qrCodeImg.src = ''; // Clear QR
                    qrMessage.textContent = '';
                    linkingStatus.textContent = message.message;
                    // If a client was just connected, update the list
                    if (message.status === 'connected') {
                        updateClientList(message.activeClients || []); // Refresh list
                        linkingStatus.style.color = 'green';
                        if (message.clientId) {
                            alert(`Client Linked: ${message.name} (${message.phoneNumber}) - ID: ${message.clientId}`);
                        }
                    } else if (message.status.includes('disconnected') || message.status === 'error' || message.status === 'linking_failed') {
                        linkingStatus.style.color = 'red';
                        // if managerQrState.linkingClientId is cleared, then this QR process is done
                        currentLinkingClientId = null;
                        updateClientList(message.activeClients || []); // Refresh list for any changes
                    } else { // connecting, reconnecting, linking_in_progress
                        linkingStatus.style.color = 'orange';
                        currentLinkingClientId = message.clientId; // Store linking client ID
                    }
                }
                break;

            case 'clientList': // Response to requestClientList
                updateClientList(message.clients || []);
                break;

            case 'ownerNumberUpdated':
                ownerNumberInput.value = message.newOwnerNumber;
                ownerStatus.textContent = `Owner updated to: ${message.newOwnerNumber}`;
                ownerStatus.style.color = 'green';
                break;

            case 'error': // Manager-level errors
                console.error('Manager Error:', message.message);
                linkingStatus.textContent = `Error: ${message.message}`;
                linkingStatus.style.color = 'red';
                break;
        }
    };

    ws.onclose = () => {
        console.log('Disconnected from WebSocket server. Attempting to reconnect...');
        // Simple reconnect logic for dev, production needs exponential backoff
        setTimeout(() => {
            new WebSocket('ws://localhost:8088'); // Re-initiate connection
        }, 3000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error:', err);
        linkingStatus.textContent = 'WebSocket connection error.';
        linkingStatus.style.color = 'red';
    };

    // --- UI Event Handlers ---
    setOwnerBtn.addEventListener('click', () => {
        const newOwner = ownerNumberInput.value.trim();
        if (newOwner) {
            ws.send(JSON.stringify({ type: 'setOwnerNumber', ownerNumber: newOwner }));
            ownerStatus.textContent = 'Updating owner number...';
            ownerStatus.style.color = 'orange';
        } else {
            ownerStatus.textContent = 'Please enter an owner number.';
            ownerStatus.style.color = 'red';
        }
    });

    linkNewClientBtn.addEventListener('click', () => {
        const apiUsername = newClientApiUsernameInput.value.trim();
        const apiPassword = newClientApiPasswordInput.value.trim();

        if (!apiUsername || !apiPassword) {
            linkingStatus.textContent = 'Please enter API Username and Password.';
            linkingStatus.style.color = 'red';
            return;
        }

        linkingStatus.textContent = 'Requesting QR code...';
        linkingStatus.style.color = 'orange';
        qrCodeImg.style.display = 'none';
        qrMessage.textContent = '';

        // Send API credentials along with the requestQr message
        ws.send(JSON.stringify({
            type: 'requestQr',
            apiUsername: apiUsername,
            apiPassword: apiPassword
        }));
    });

    refreshClientsBtn.addEventListener('click', () => {
        ws.send(JSON.stringify({ type: 'requestClientList' }));
        clientList.innerHTML = '<li>Refreshing clients...</li>';
    });

    // --- Helper Function to Update Client List ---
    function updateClientList(clients) {
        clientList.innerHTML = ''; // Clear existing list
        if (clients.length === 0) {
            clientList.innerHTML = '<li>No active clients.</li>';
            return;
        }
        clients.forEach(client => {
            const li = document.createElement('li');
            li.innerHTML = `
                <div>
                    <strong>ID:</strong> ${client.clientId} <br>
                    <strong>Phone:</strong> ${client.phoneNumber || 'N/A'} <br>
                    <strong>Name:</strong> ${client.name || 'N/A'}
                    <span class="status ${client.status}">${client.status.replace(/_/g, ' ')}</span>
                </div>
                <div class="actions">
                    <button class="restart-btn" data-client-id="${client.clientId}">Restart</button>
                    <button class="stop-btn" data-client-id="${client.clientId}">Stop</button>
                </div>
            `;
            clientList.appendChild(li);

            // Add event listeners to dynamically created buttons
            li.querySelector('.restart-btn').addEventListener('click', (e) => {
                const clientId = e.target.dataset.clientId;
                ws.send(JSON.stringify({ type: 'restartClient', clientId: clientId }));
                console.log(`Requested restart for ${clientId}`);
            });

            li.querySelector('.stop-btn').addEventListener('click', (e) => {
                const clientId = e.target.dataset.clientId;
                ws.send(JSON.stringify({ type: 'stopClient', clientId: clientId }));
                console.log(`Requested stop for ${clientId}`);
            });
        });
    }

    // Initial load of clients (can also be done on ws.onopen with requestInitialState)
    // ws.send(JSON.stringify({ type: 'requestClientList' })); // Moved to onopen for full initial state
});