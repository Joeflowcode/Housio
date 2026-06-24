(function () {
  const categories = window.HOUSIO_DIRECTORY_CATEGORIES || [];
  const listings = window.HOUSIO_DIRECTORY_LISTINGS || [];
  const categoryGrid = document.getElementById('categoryGrid');
  const filterWrap = document.getElementById('directoryFilters');
  const listingGrid = document.getElementById('listingGrid');
  const listingTitle = document.getElementById('listingTitle');
  const listingSub = document.getElementById('listingSub');
  const countEl = document.getElementById('listingCount');

  const params = new URLSearchParams(location.search);
  let active = params.get('category') || 'all';

  function joinUrl(service) {
    return `index.html?join=pro&service=${encodeURIComponent(service)}&utm=directory`;
  }

  function categoryBySlug(slug) {
    return categories.find(c => c.slug === slug);
  }

  function renderCategories() {
    if (!categoryGrid) return;
    categoryGrid.innerHTML = categories.map(c => `
      <article class="category-card">
        <h3>${c.title}</h3>
        <p>${c.description}</p>
        <div class="card-actions">
          <a class="mini primary" href="bend-local-pros.html?category=${encodeURIComponent(c.slug)}#directory">View directory</a>
          <a class="mini" href="${joinUrl(c.service)}">Add your business</a>
        </div>
      </article>
    `).join('');
  }

  function renderFilters() {
    if (!filterWrap) return;
    filterWrap.innerHTML = [
      `<button class="filter ${active === 'all' ? 'active' : ''}" data-cat="all">All services</button>`,
      ...categories.map(c => `<button class="filter ${active === c.slug ? 'active' : ''}" data-cat="${c.slug}">${c.service}</button>`)
    ].join('');
    filterWrap.querySelectorAll('[data-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        active = btn.dataset.cat;
        const url = active === 'all' ? 'bend-local-pros.html#directory' : `bend-local-pros.html?category=${encodeURIComponent(active)}#directory`;
        history.replaceState(null, '', url);
        renderFilters();
        renderListings();
      });
    });
  }

  function renderListings() {
    if (!listingGrid) return;
    const cat = categoryBySlug(active);
    const filtered = active === 'all' ? listings : listings.filter(l => l.category === active);
    if (listingTitle) listingTitle.textContent = cat ? cat.title : 'Bend local service directory';
    if (listingSub) listingSub.textContent = cat
      ? `${cat.description} Local owners can claim or add a free Housio profile.`
      : 'Browse manually approved service categories for Bend and Central Oregon.';
    if (countEl) countEl.textContent = `${filtered.length} listed`;

    if (!filtered.length) {
      const service = cat?.service || 'your service';
      listingGrid.innerHTML = `
        <div class="empty">
          <span class="badge">Founding directory</span>
          <h3>No approved listings yet${cat ? ` for ${cat.service}` : ''}.</h3>
          <p>We are opening this directory slowly so it stays useful and accurate. Local business owners can add a free profile and homeowners can still post a request.</p>
          <div class="card-actions">
            <a class="mini primary" href="${joinUrl(cat?.service || '')}">Add your business</a>
            <a class="mini" href="index.html${cat ? `?service=${encodeURIComponent(cat.service)}&utm=directory` : '#categories'}">Post a homeowner request</a>
          </div>
        </div>
        <div class="claim-card">
          <h3>What a listing includes</h3>
          <p>Business name, service category, city, website, public phone, claimed status, and a path to become a verified Housio pro.</p>
        </div>
        <div class="claim-card">
          <h3>Why claim early?</h3>
          <p>Founding pros join free, pay no lead fees, and only pay Housio when a homeowner pays them for completed work.</p>
        </div>
      `;
      return;
    }

    listingGrid.innerHTML = filtered.map(l => {
      const cat = categoryBySlug(l.category);
      return `<article class="listing-card">
        <span class="badge">${l.status === 'claimed' ? 'Claimed' : 'Unclaimed'}</span>
        <h3>${l.name}</h3>
        <p>${cat?.service || 'Local service'} in ${l.city || 'Central Oregon'}</p>
        ${l.notes ? `<p>${l.notes}</p>` : ''}
        <div class="card-actions">
          ${l.website ? `<a class="mini" href="${l.website}" target="_blank" rel="noopener">Website</a>` : ''}
          ${l.phone ? `<a class="mini" href="tel:${l.phone.replace(/[^0-9+]/g, '')}">Call</a>` : ''}
          <a class="mini primary" href="${joinUrl(cat?.service || '')}">${l.status === 'claimed' ? 'Join Housio' : 'Claim profile'}</a>
        </div>
      </article>`;
    }).join('');
  }

  renderCategories();
  renderFilters();
  renderListings();
})();
