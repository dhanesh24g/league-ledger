class NotificationManager {
  constructor() {
    this.notifications = [];
    this.notificationBtn = document.getElementById('notification-btn');
    this.notificationBadge = document.getElementById('notification-badge');
    this.notificationDropdown = document.getElementById('notification-dropdown');
    this.notificationList = document.getElementById('notification-list');
    this.clearNotificationsBtn = document.getElementById('clear-notifications');

    this.init();
  }

  init() {
    if (!this.notificationBtn) return;

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
  }

  toggleNotificationDropdown() {
    if (this.notificationDropdown.classList.contains('hidden')) {
      this.openNotificationDropdown();
    } else {
      this.closeNotificationDropdown();
    }
  }

  openNotificationDropdown() {
    this.notificationDropdown.classList.remove('hidden');
    this.renderNotifications();
    // Mark all as read when opening
    this.markAllAsRead();
  }

  closeNotificationDropdown() {
    this.notificationDropdown.classList.add('hidden');
  }

  loadNotifications() {
    try {
      const stored = localStorage.getItem('league-ledger-notifications');
      this.notifications = stored ? JSON.parse(stored) : [];
    } catch (error) {
      this.notifications = [];
    }
  }

  saveNotifications() {
    try {
      localStorage.setItem('league-ledger-notifications', JSON.stringify(this.notifications));
    } catch (error) {
      console.warn('Failed to save notifications:', error);
    }
  }

  addNotification(notification) {
    const newNotification = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      read: false,
      ...notification
    };

    this.notifications.unshift(newNotification);
    this.saveNotifications();
    this.updateBadge();
    this.renderNotifications();
  }

  markAsRead(notificationId) {
    const notification = this.notifications.find(n => n.id === notificationId);
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
    this.notifications = this.notifications.filter(n => n.id !== notificationId);
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
        const notificationId = parseFloat(item.dataset.id);
        this.markAsRead(notificationId);

        // Handle notification action if specified
        const notification = this.notifications.find(n => n.id === notificationId);
        if (notification?.action) {
          this.handleNotificationAction(notification);
        }
      });
    });
  }

  handleNotificationAction(notification) {
    if (notification.action === 'navigate' && notification.url) {
      window.location.href = notification.url;
    } else if (notification.action === 'refresh') {
      window.location.reload();
    } else if (notification.action === 'callback' && notification.callback) {
      notification.callback();
    }
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
