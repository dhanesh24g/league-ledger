import { callApi } from '/static/workflow-common.js';

class NotificationManager {
  constructor() {
    this.notifications = [];
    this.user = null;
    this.syncTimer = null;
    this.isSyncing = false;
    this.hasBootstrapped = false;
    this.syncIntervalMs = 60000;
    this.storageKey = 'league-ledger-notifications';
    this.trackerStorageKey = '';
    this.notificationBtn = document.getElementById('notification-btn');
    this.notificationBadge = document.getElementById('notification-badge');
    this.notificationDropdown = document.getElementById('notification-dropdown');
    this.notificationList = document.getElementById('notification-list');
    this.clearNotificationsBtn = document.getElementById('clear-notifications');
    this.reviewModal = null;
    this.handleViewportChange = () => {
      if (!this.notificationDropdown || this.notificationDropdown.classList.contains('hidden')) return;
      this.positionNotificationDropdown();
    };

    this.init();
  }

  init() {
    if (!this.notificationBtn || !this.notificationDropdown || !this.notificationList || !this.notificationBadge) return;

    // Load notifications from localStorage
    this.loadNotifications();

    // Event listeners
    this.notificationBtn.addEventListener('click', () => this.toggleNotificationDropdown());

    this.clearNotificationsBtn?.addEventListener('click', () => {
      this.clearAllNotifications();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.notification-wrapper')) {
        this.closeNotificationDropdown();
      }
    });

    // Update badge
    this.updateBadge();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.hasBootstrapped) return;
      this.syncServerNotifications();
    });

    window.addEventListener('focus', () => {
      if (!this.hasBootstrapped) return;
      this.syncServerNotifications();
    });

    window.addEventListener('resize', this.handleViewportChange);
    window.addEventListener('orientationchange', this.handleViewportChange);
    window.addEventListener('scroll', this.handleViewportChange, { passive: true });
  }

  shouldUseViewportDropdownPosition() {
    return window.matchMedia('(max-width: 1100px)').matches;
  }

  resetNotificationDropdownPosition() {
    if (!this.notificationDropdown) return;
    this.notificationDropdown.style.removeProperty('top');
    this.notificationDropdown.style.removeProperty('left');
    this.notificationDropdown.style.removeProperty('right');
    this.notificationDropdown.style.removeProperty('width');
    this.notificationDropdown.style.removeProperty('max-width');
  }

  positionNotificationDropdown() {
    if (!this.notificationBtn || !this.notificationDropdown) return;

    if (!this.shouldUseViewportDropdownPosition()) {
      this.resetNotificationDropdownPosition();
      return;
    }

    const buttonRect = this.notificationBtn.getBoundingClientRect();
    const topOffset = Math.max(8, Math.round(buttonRect.bottom + 8));

    this.notificationDropdown.style.top = `${topOffset}px`;
    this.notificationDropdown.style.left = '12px';
    this.notificationDropdown.style.right = '12px';
    this.notificationDropdown.style.width = 'auto';
    this.notificationDropdown.style.maxWidth = 'none';
  }

  async ensureServerSyncStarted() {
    if (this.hasBootstrapped) {
      this.syncServerNotifications();
      return;
    }
    await this.bootstrapServerSync();
  }

  async bootstrapServerSync() {
    if (this.hasBootstrapped) return;
    try {
      const profile = await callApi('/api/auth/me');
      this.user = profile.user || null;
      if (!this.user?.id) return;

      this.hasBootstrapped = true;

      this.storageKey = `league-ledger-notifications:${this.user.id}`;
      this.trackerStorageKey = `league-ledger-notification-tracker:${this.user.id}`;
      this.loadNotifications();
      this.updateBadge();
      this.renderNotifications();

      await this.syncServerNotifications(this.user);
      this.syncTimer = window.setInterval(() => {
        this.syncServerNotifications();
      }, this.syncIntervalMs);
    } catch (error) {
      console.warn('Notification sync bootstrap failed:', error);
    }
  }

  loadTracker() {
    if (!this.trackerStorageKey) {
      return { adminPendingRequestIds: [], selfPendingLeagueIds: [] };
    }
    try {
      const stored = localStorage.getItem(this.trackerStorageKey);
      const parsed = stored ? JSON.parse(stored) : {};
      return {
        adminPendingRequestIds: Array.isArray(parsed.adminPendingRequestIds) ? parsed.adminPendingRequestIds : [],
        selfPendingLeagueIds: Array.isArray(parsed.selfPendingLeagueIds) ? parsed.selfPendingLeagueIds : [],
      };
    } catch {
      return { adminPendingRequestIds: [], selfPendingLeagueIds: [] };
    }
  }

  saveTracker(tracker) {
    if (!this.trackerStorageKey) return;
    try {
      localStorage.setItem(this.trackerStorageKey, JSON.stringify(tracker));
    } catch (error) {
      console.warn('Failed to save notification tracker:', error);
    }
  }

  async syncServerNotifications(currentUser = null) {
    if (!this.user || this.isSyncing) return;
    this.isSyncing = true;

    try {
      const latestUser = currentUser || (await callApi('/api/auth/me')).user || this.user;
      this.user = latestUser;

      const tracker = this.loadTracker();

      if (latestUser.league_role === 'admin' && latestUser.active_league_id) {
        try {
          const requestResult = await callApi('/api/league/requests');
          const requests = Array.isArray(requestResult.requests) ? requestResult.requests : [];
          const currentIds = requests.map((request) => String(request.request_id)).sort();
          const previousIds = new Set((tracker.adminPendingRequestIds || []).map((id) => String(id)));

          requests
            .filter((request) => !previousIds.has(String(request.request_id)))
            .forEach((request) => {
              this.addNotification({
                title: 'New Join Request',
                message: `${request.first_name} ${request.last_name} requested to join your league.`,
                icon: '👤',
                action: 'review_join_request',
                request,
              });
            });

          tracker.adminPendingRequestIds = currentIds;
        } catch (error) {
          // ignore request fetch errors for non-admin surfaces
        }
      }

      const previousPendingIds = (tracker.selfPendingLeagueIds || []).map((id) => Number(id));
      const currentPendingIds = Array.isArray(latestUser.pending_requests)
        ? latestUser.pending_requests.map((item) => Number(item.league_id)).filter((id) => Number.isFinite(id))
        : [];
      const currentMembershipMap = new Map(
        (Array.isArray(latestUser.memberships) ? latestUser.memberships : []).map((item) => [Number(item.league_id), item])
      );

      previousPendingIds
        .filter((leagueId) => !currentPendingIds.includes(leagueId) && currentMembershipMap.has(leagueId))
        .forEach((leagueId) => {
          const membership = currentMembershipMap.get(leagueId);
          const leagueName = membership?.league?.name || 'your league';
          this.addNotification({
            title: 'Join Request Approved',
            message: `Your request to join ${leagueName} was approved.`,
            icon: '✅',
            action: 'navigate',
            url: '/league-details',
          });
        });

      tracker.selfPendingLeagueIds = currentPendingIds;
      this.saveTracker(tracker);
    } catch (error) {
      console.warn('Notification sync failed:', error);
    } finally {
      this.isSyncing = false;
    }
  }

  toggleNotificationDropdown() {
    if (this.notificationDropdown.classList.contains('hidden')) {
      this.openNotificationDropdown();
    } else {
      this.closeNotificationDropdown();
    }
  }

  openNotificationDropdown() {
    this.positionNotificationDropdown();
    this.notificationDropdown.classList.remove('hidden');
    this.ensureServerSyncStarted();
    this.renderNotifications();
    // Mark all as read when opening
    this.markAllAsRead();
  }

  closeNotificationDropdown() {
    this.notificationDropdown.classList.add('hidden');
  }

  loadNotifications() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      this.notifications = stored ? JSON.parse(stored) : [];
    } catch (error) {
      this.notifications = [];
    }
  }

  saveNotifications() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.notifications));
    } catch (error) {
      console.warn('Failed to save notifications:', error);
    }
  }

  addNotification(notification) {
    const newNotification = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      read: false,
      ...notification
    };

    this.notifications.unshift(newNotification);
    this.saveNotifications();
    this.updateBadge();
    this.renderNotifications();
  }

  normalizeNotificationId(notificationId) {
    return String(notificationId || '').trim();
  }

  findNotificationById(notificationId) {
    const normalizedId = this.normalizeNotificationId(notificationId);
    if (!normalizedId) return null;

    const exact = this.notifications.find((item) => this.normalizeNotificationId(item.id) === normalizedId);
    if (exact) return exact;

    const legacyNumeric = Number(normalizedId);
    if (Number.isFinite(legacyNumeric)) {
      return this.notifications.find((item) => Number(item.id) === legacyNumeric) || null;
    }
    return null;
  }

  markAsRead(notificationId) {
    const notification = this.findNotificationById(notificationId);
    if (notification) {
      notification.read = true;
      this.saveNotifications();
      this.updateBadge();
      this.renderNotifications();
    }
  }

  markAllAsRead() {
    this.notifications.forEach(n => n.read = true);
    this.saveNotifications();
    this.updateBadge();
    this.renderNotifications();
  }

  clearAllNotifications() {
    this.notifications = [];
    this.saveNotifications();
    this.updateBadge();
    this.renderNotifications();
    this.closeNotificationDropdown();
  }

  removeNotification(notificationId) {
    const normalizedId = this.normalizeNotificationId(notificationId);
    this.notifications = this.notifications.filter((item) => this.normalizeNotificationId(item.id) !== normalizedId);
    this.saveNotifications();
    this.updateBadge();
    this.renderNotifications();
  }

  getUnreadCount() {
    return this.notifications.filter(n => !n.read).length;
  }

  updateBadge() {
    const unreadCount = this.getUnreadCount();
    if (unreadCount > 0) {
      this.notificationBadge.textContent = unreadCount > 99 ? '99+' : unreadCount;
      this.notificationBadge.classList.remove('hidden');
    } else {
      this.notificationBadge.classList.add('hidden');
    }
  }

  toggleDropdown() {
    // Legacy method - redirect to notification dropdown
    this.toggleNotificationDropdown();
  }

  closeDropdown() {
    // Legacy method - close dropdown
    this.closeNotificationDropdown();
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  renderNotifications() {
    if (!this.notificationList) return;

    if (this.notifications.length === 0) {
      this.notificationList.innerHTML = '<div class="notification-empty">No notifications</div>';
      return;
    }

    const notificationsHTML = this.notifications.map(notification => `
      <div class="notification-item ${!notification.read ? 'unread' : ''}" data-id="${notification.id}">
        <div class="notification-icon-small">${notification.icon || '📢'}</div>
        <div class="notification-content">
          <div class="notification-title">${notification.title}</div>
          <div class="notification-message">${notification.message}</div>
          <div class="notification-time">${this.formatTime(notification.timestamp)}</div>
        </div>
      </div>
    `).join('');

    this.notificationList.innerHTML = notificationsHTML;

    // Add click handlers
    this.notificationList.querySelectorAll('.notification-item').forEach(item => {
      item.addEventListener('click', () => {
        const notificationId = item.dataset.id || '';
        this.markAsRead(notificationId);

        // Handle notification action if specified
        const notification = this.findNotificationById(notificationId);
        if (notification?.action) {
          this.handleNotificationAction(notification);
        }
      });
    });
  }

  handleNotificationAction(notification) {
    if (notification.action === 'review_join_request' && notification.request) {
      this.openJoinRequestReview(notification);
    } else if (notification.action === 'navigate' && notification.url) {
      window.location.href = notification.url;
    } else if (notification.action === 'refresh') {
      window.location.reload();
    } else if (notification.action === 'callback' && notification.callback) {
      notification.callback();
    }
  }

  ensureReviewModal() {
    if (this.reviewModal) return this.reviewModal;

    const modal = document.createElement('div');
    modal.className = 'notification-review-modal hidden';
    modal.innerHTML = `
      <div class="notification-review-backdrop" data-close-review></div>
      <section class="notification-review-panel" role="dialog" aria-modal="true" aria-labelledby="notification-review-title">
        <div class="notification-review-header">
          <h3 id="notification-review-title">Review Join Request</h3>
          <button type="button" class="ghost" data-close-review>Close</button>
        </div>
        <div class="notification-review-body" id="notification-review-body"></div>
        <div class="notification-review-actions">
          <button type="button" class="notification-approve-btn" id="notification-approve-btn">✅ Approve</button>
          <button type="button" class="notification-reject-btn" id="notification-reject-btn">❌ Reject</button>
        </div>
      </section>
    `;

    modal.querySelectorAll('[data-close-review]').forEach((node) => {
      node.addEventListener('click', () => this.closeJoinRequestReview());
    });

    document.body.appendChild(modal);
    this.reviewModal = modal;
    return modal;
  }

  closeJoinRequestReview() {
    if (!this.reviewModal) return;
    this.reviewModal.classList.add('hidden');
    document.body.classList.remove('modal-open');
  }

  async submitJoinRequestReview(requestId, action, notificationId) {
    if (!requestId) return;

    const endpoint = action === 'approve'
      ? `/api/league/requests/${requestId}/approve`
      : `/api/league/requests/${requestId}/reject`;
    const body = action === 'approve' ? JSON.stringify({ role: 'read' }) : undefined;

    await callApi(endpoint, {
      method: 'POST',
      ...(body ? { body } : {}),
    });

    this.removeNotification(notificationId);
    await this.syncServerNotifications();
    this.closeJoinRequestReview();
  }

  openJoinRequestReview(notification) {
    const request = notification.request || {};
    const modal = this.ensureReviewModal();
    const body = modal.querySelector('#notification-review-body');
    const approveBtn = modal.querySelector('#notification-approve-btn');
    const rejectBtn = modal.querySelector('#notification-reject-btn');

    if (!body || !approveBtn || !rejectBtn) return;

    body.innerHTML = `
      <p><strong>${request.first_name || ''} ${request.last_name || ''}</strong></p>
      <p class="muted">${request.user_id_label || ''}${request.email ? ` • ${request.email}` : ''}</p>
      <p class="muted small">Choose what to do with this request.</p>
    `;

    const handleAction = async (action) => {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      try {
        await this.submitJoinRequestReview(request.request_id, action, notification.id);
      } catch (error) {
        console.warn('Join request review failed:', error);
      } finally {
        approveBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    };

    approveBtn.onclick = () => handleAction('approve');
    rejectBtn.onclick = () => handleAction('reject');

    modal.classList.remove('hidden');
    document.body.classList.add('modal-open');
  }

  // Static methods for easy access from other modules
  static showJoinRequest(user, league) {
    const manager = window.notificationManager;
    if (manager) {
      manager.addNotification({
        title: 'New Join Request',
        message: `${user.first_name} ${user.last_name} wants to join ${league.name}`,
        icon: '👤',
        action: 'navigate',
        url: '/setup'
      });
    }
  }

  static showJoinApproved(league) {
    const manager = window.notificationManager;
    if (manager) {
      manager.addNotification({
        title: 'Join Request Approved',
        message: `You've been approved to join ${league.name}`,
        icon: '✅',
        action: 'navigate',
        url: '/stats'
      });
    }
  }

  static showMatchResults(matchTitle) {
    const manager = window.notificationManager;
    if (manager) {
      manager.addNotification({
        title: 'Match Results Updated',
        message: `Results for "${matchTitle}" have been posted`,
        icon: '🏆',
        action: 'navigate',
        url: '/winners'
      });
    }
  }

  static showCustom(title, message, icon = '📢', action = null, url = null) {
    const manager = window.notificationManager;
    if (manager) {
      manager.addNotification({
        title,
        message,
        icon,
        action,
        url
      });
    }
  }
}

// Initialize notification manager
export function initNotifications() {
  window.notificationManager = new NotificationManager();
  return window.notificationManager;
}

export default NotificationManager;
