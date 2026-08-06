// Funcionalidade de alternar o Menu Lateral
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');
    sidebar.classList.toggle('open');
    toggleBtn.classList.toggle('open');
}

// Dropdowns de Header
const searchInput = document.getElementById('searchInput');
const searchSuggestions = document.getElementById('searchSuggestions');

if (searchInput) {
    searchInput.addEventListener('focus', () => {
        searchSuggestions.classList.add('show');
    });
}

const btnFiltros = document.getElementById('btnFiltros');
const filtrosDropdown = document.getElementById('filtrosDropdown');

if (btnFiltros) {
    btnFiltros.addEventListener('click', (event) => {
        event.stopPropagation();
        filtrosDropdown.classList.toggle('show');
        btnFiltros.classList.toggle('active');
    });
}

document.addEventListener('click', (event) => {
    if (searchInput && searchSuggestions && !searchInput.contains(event.target) && !searchSuggestions.contains(event.target)) {
        searchSuggestions.classList.remove('show');
    }
    if (btnFiltros && filtrosDropdown && !btnFiltros.contains(event.target) && !filtrosDropdown.contains(event.target)) {
        filtrosDropdown.classList.remove('show');
        if(btnFiltros.classList) btnFiltros.classList.remove('active');
    }
});

// Verifica se estamos visualizando o perfil de outra pessoa pelo parâmetro da URL
document.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const isOtherUser = urlParams.get('view') === 'other';
    
    // Lógica do Cadeado de Perfil Privado
    const padlock = document.getElementById('privatePadlockProfile');
    if (padlock) {
        if (!isOtherUser) {
            // Nosso próprio perfil - lê do localStorage
            const storedPrivate = localStorage.getItem('isPrivateProfile');
            const isPrivate = storedPrivate === null ? true : (storedPrivate === 'true');
            padlock.style.display = isPrivate ? 'inline-block' : 'none';
        } else {
            // Perfil de terceiros - para a demonstração, podemos omitir
            padlock.style.display = 'none';
        }
    }

    if (isOtherUser) {
        // Esconde o botão de Editar Perfil
        const btnEditProfile = document.querySelector('.btn-edit-profile');
        if (btnEditProfile) {
            btnEditProfile.style.display = 'none';
        }
        
        // Simula a mudança de nome/usuário caso tenha pego do post
        const nameParam = urlParams.get('name');
        if (nameParam) {
            const profileName = document.querySelector('.profile-name');
            const profileUsername = document.querySelector('.profile-username');
            // Remove emojis caso a pessoa tenha colocado no nome de usuário simulado
            const cleanName = nameParam.replace(/[\u{1F600}-\u{1F6FF}]/gu, '').trim(); 
            if (profileName) profileName.innerText = cleanName;
            if (profileUsername) profileUsername.innerText = '@' + cleanName.toLowerCase().replace(/\s+/g, '');
        }
    }
});

// Lógica de abas do perfil público
const tabBtns = document.querySelectorAll('.tab-btn');
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // No futuro, aqui pode ser adicionada a lógica de alternar os painéis de conteúdo
    });
});
