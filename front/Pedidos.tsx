import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Printer, ArrowRightCircle, RotateCw, Truck, MapPin, X, Eye, CreditCard, Smartphone, DollarSign, Edit, Trash2, Plus, Save, List, ChevronDown, AlertCircle, UtensilsCrossed, Store, MoreVertical, User, Phone, Hash, Receipt, Package, StickyNote } from 'lucide-react';
import { Order, Product, Flavor } from '../../types';
import { sendPrintOrderJob } from '../../utils/printOrderWebSocket';
import apiService from '../../services/api';
import { useNotification } from '../../components/NotificationProvider';

// Função para traduzir status para português
const getStatusInPortuguese = (status: string) => {
  const statusMap: { [key: string]: string } = {
    'pending_payment': 'Pagamento Pendente',
    'being_prepared': 'Preparando',
    'ready_for_pickup': 'Pronto para Retirada',
    'on_the_way': 'A Caminho',
    'delivered': 'Entregue',
    'canceled': 'Cancelado',
    'closed': 'Conta fechada'
  };
  return statusMap[status] || status;
};

// Função para obter estilo do status
const getStatusStyle = (status: string) => {
  const statusStyles: { [key: string]: string } = {
    'pending_payment': 'bg-yellow-100 text-yellow-800 border border-yellow-200',
    'being_prepared': 'bg-blue-100 text-blue-800 border border-blue-200',
    'ready_for_pickup': 'bg-orange-100 text-orange-800 border border-orange-200',
    'on_the_way': 'bg-purple-100 text-purple-800 border border-purple-200',
    'delivered': 'bg-green-100 text-green-800 border border-green-200',
    'canceled': 'bg-red-100 text-red-800 border border-red-200',
    'closed': 'bg-slate-100 text-slate-700 border border-slate-200'
  };
  return statusStyles[status] || 'bg-gray-100 text-gray-800 border border-gray-200';
};

const sortOrdersOldestFirst = (list: Order[]) =>
  [...list].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

/** Coluna "Em preparo": pedidos de mesa (dine_in) primeiro; depois mais antigos no topo em cada grupo. */
const sortPreparingOrdersMesaFirst = (list: Order[]) =>
  [...list].sort((a, b) => {
    const aMesa = a.deliveryType === 'dine_in' ? 0 : 1;
    const bMesa = b.deliveryType === 'dine_in' ? 0 : 1;
    if (aMesa !== bMesa) return aMesa - bMesa;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

/** Coluna verde: a caminho / pronto para retirada primeiro; depois entregues, conta fechada e cancelados. */
const sortFinalPhaseOrders = (list: Order[]) => {
  const rank = (s: string) =>
    s === 'on_the_way' || s === 'ready_for_pickup' ? 0 : 1;
  return [...list].sort((a, b) => {
    const ra = rank(a.status);
    const rb = rank(b.status);
    if (ra !== rb) return ra - rb;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
};

const getPaymentDisplay = (order: Order): { label: string; className: string } | null => {
  const method = String(order.paymentMethod || '').toUpperCase();
  const methodLabel =
    method === 'PIX'
      ? 'PIX'
      : method === 'CREDIT_CARD'
      ? 'Cartão'
      : method === 'CASH_ON_DELIVERY'
      ? 'Dinheiro'
      : 'Forma não informada';
  const isYellow = order.status === 'pending_payment' || order.status === 'canceled';
  const isBlue = order.status === 'being_prepared';
  const isOnTheWayOrReady = order.status === 'on_the_way' || order.status === 'ready_for_pickup';
  const isFinalSection = ['on_the_way', 'ready_for_pickup', 'delivered', 'closed'].includes(order.status);
  const isDelivered = order.status === 'delivered';
  const isMesaContaFechada = order.deliveryType === 'dine_in' && order.status === 'closed';
  const isMesaSemContaFechada = order.deliveryType === 'dine_in' && order.status !== 'closed';

  // Em pedidos de mesa, só exibir forma de pagamento após fechar a conta.
  if (isMesaSemContaFechada) return null;

  if (method === 'PIX') {
    if (isBlue || isOnTheWayOrReady) {
      return {
        label: `${methodLabel} • Pedido pago`,
        className: 'text-emerald-700 bg-emerald-50 border-emerald-200'
      };
    }
    if (isMesaContaFechada) {
      return {
        label: `${methodLabel} • Pedido pago`,
        className: 'text-emerald-700 bg-emerald-50 border-emerald-200'
      };
    }
    if (isFinalSection && !isDelivered) {
      return {
        label: `${methodLabel} • Aguardando confirmação`,
        className: 'text-purple-700 bg-purple-50 border-purple-200'
      };
    }
    return {
      label: isYellow ? `${methodLabel} • Pendente` : isDelivered ? `${methodLabel} • Pedido pago` : `${methodLabel} • Pendente`,
      className: isYellow
        ? 'text-purple-700 bg-purple-50 border-purple-200'
        : 'text-emerald-700 bg-emerald-50 border-emerald-200'
    };
  }

  if (method === 'CREDIT_CARD' || method === 'CASH_ON_DELIVERY') {
    return {
      label: isDelivered || isMesaContaFechada ? `${methodLabel} • Pedido pago` : `${methodLabel} • Ainda não pago`,
      className: isDelivered || isMesaContaFechada
        ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
        : isBlue || isYellow || isFinalSection
        ? 'text-amber-700 bg-amber-50 border-amber-200'
        : 'text-slate-600 bg-slate-50 border-slate-200'
    };
  }

  return {
    label: methodLabel,
    className: 'text-slate-600 bg-slate-50 border-slate-200'
  };
};

const Pedidos: React.FC<{ 
  orders: Order[], 
  handleAdvanceStatus: (order: Order) => void,
  onRefresh?: () => void,
  /** Pedido em entrega: trocar entregador e reenviar WhatsApp */
  onReassignDeliverer?: (order: Order) => void,
}> = ({ orders, handleAdvanceStatus, onRefresh, onReassignDeliverer }) => {
  const { notify } = useNotification();
  const navigate = useNavigate();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (onRefresh) {
      setIsRefreshing(true);
      try {
        await onRefresh();
      } finally {
        // Pequeno delay para mostrar o feedback visual
        setTimeout(() => setIsRefreshing(false), 500);
      }
    }
  };
  
  // Estados para os filtros
  const [dateFilter, setDateFilter] = useState<string>('today');
  /** Padrão `all`: inclui mesa (dine_in). "Delivery" no filtro esconde pedidos de mesa. */
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  
  // Estados para edição
  const [isEditing, setIsEditing] = useState(false);
  const [editedTotal, setEditedTotal] = useState<string>('');
  const [products, setProducts] = useState<Product[]>([]);
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemProductId, setNewItemProductId] = useState<number>(0);
  const [newItemQuantity, setNewItemQuantity] = useState<number>(1);
  const [newItemPrice, setNewItemPrice] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [showComplementsModal, setShowComplementsModal] = useState<{ orderId: number, itemId: number, complements: any[] } | null>(null);
  const [flavors, setFlavors] = useState<Flavor[]>([]);
  const [deliveryEstimate, setDeliveryEstimate] = useState<string>(''); // Estimativa de entrega em minutos
  const [currentTime, setCurrentTime] = useState<Date>(new Date()); // Para atualizar o timer
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Order | null>(null); // Modal de confirmação de exclusão
  /** Menu ⋮ do card (um pedido por vez) */
  const [cardMenuOrderId, setCardMenuOrderId] = useState<number | null>(null);
  const [cardMenuAnchor, setCardMenuAnchor] = useState<DOMRect | null>(null);
  const [mobileSection, setMobileSection] = useState<'pending' | 'preparing' | 'final'>('pending');

  const closeCardMenu = useCallback(() => {
    setCardMenuOrderId(null);
    setCardMenuAnchor(null);
  }, []);

  // Fechar menu ⋮ ao clicar fora
  useEffect(() => {
    if (cardMenuOrderId == null) return;
    const handleDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest('[data-order-card-menu]')) closeCardMenu();
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [cardMenuOrderId, closeCardMenu]);

  // Fechar ao rolar (lista ou página)
  useEffect(() => {
    if (cardMenuOrderId == null) return;
    const handleScroll = () => closeCardMenu();
    window.addEventListener('scroll', handleScroll, true);
    return () => window.removeEventListener('scroll', handleScroll, true);
  }, [cardMenuOrderId, closeCardMenu]);

  // Carregar produtos quando abrir modal de edição
  useEffect(() => {
    if (isEditing && selectedOrder) {
      loadProducts();
      setEditedTotal(selectedOrder.totalPrice.toString());
    }
  }, [isEditing, selectedOrder]);

  // Carregar sabores
  useEffect(() => {
    const loadFlavors = async () => {
      try {
        const flavorsData = await apiService.getFlavors();
        setFlavors(flavorsData);
      } catch (error) {
        console.error('Erro ao carregar sabores:', error);
      }
    };
    loadFlavors();
  }, []);

  // Carregar estimativa de entrega das configurações
  useEffect(() => {
    const loadDeliveryEstimate = async () => {
      try {
        const config = await apiService.getStoreConfig();
        const estimativa = config?.estimativaEntrega || '';
        // Extrair todos os números da estimativa e pegar o maior (ex: "30-45 min" → 45, "20 a 30 minutos" → 30)
        const numbers = estimativa.match(/\d+/g);
        if (numbers && numbers.length > 0) {
          // Converter para números e pegar o maior
          const maxNumber = Math.max(...numbers.map((n: string) => parseInt(n, 10)));
          setDeliveryEstimate(maxNumber.toString());
        } else {
          // Valor padrão se não encontrar números
          setDeliveryEstimate('45');
        }
      } catch (error) {
        console.error('Erro ao carregar estimativa de entrega:', error);
        setDeliveryEstimate('45'); // Valor padrão
      }
    };
    loadDeliveryEstimate();
  }, []);

  // Atualizar tempo atual a cada segundo para o timer
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Função para obter sabores do item do pedido
  const getItemFlavors = (item: any): Flavor[] => {
    if (!item.selectedOptionsSnapshot || !flavors.length) return [];

    // Tentar diferentes formatos de estrutura
    let selectedFlavors: any = {};
    
    if (item.selectedOptionsSnapshot.selectedFlavors) {
      selectedFlavors = item.selectedOptionsSnapshot.selectedFlavors;
    } else if (item.selectedOptionsSnapshot.flavors) {
      selectedFlavors = item.selectedOptionsSnapshot.flavors;
    } else {
      return [];
    }

    // Se selectedFlavors está vazio, retornar array vazio
    if (Object.keys(selectedFlavors).length === 0) {
      return [];
    }

    // Coletar todos os IDs de sabores selecionados
    // As chaves podem vir como strings ou números do JSON
    const flavorIds: number[] = [];
    Object.values(selectedFlavors).forEach((ids: any) => {
      if (Array.isArray(ids)) {
        flavorIds.push(...ids.map((id: any) => Number(id)));
      }
    });

    // Buscar os sabores pelos IDs
    return flavors.filter(flavor => flavorIds.includes(flavor.id));
  };

  // Polling automático para verificar novos pedidos a cada 5 segundos
  useEffect(() => {
    if (!onRefresh) return;

    const intervalId = setInterval(() => {
      // Atualizar pedidos silenciosamente
      onRefresh();
    }, 5000); // Verificar a cada 5 segundos

    // Limpar intervalo quando o componente for desmontado
    return () => clearInterval(intervalId);
  }, [onRefresh]);

  // Mantém o pedido aberto no modal sincronizado com atualizações em tempo real.
  useEffect(() => {
    if (!selectedOrder) return;

    const updatedOrder = orders.find(order => order.id === selectedOrder.id);

    if (!updatedOrder) {
      // Se o pedido deixou de existir na lista atual, fecha o modal.
      setIsEditing(false);
      setSelectedOrder(null);
      setShowAddItem(false);
      return;
    }

    if (updatedOrder !== selectedOrder) {
      setSelectedOrder(updatedOrder);
    }
  }, [orders, selectedOrder]);

  const loadProducts = async () => {
    try {
      const prods = await apiService.getProducts();
      setProducts(prods.filter(p => p.isActive));
    } catch (error) {
      console.error('Erro ao carregar produtos:', error);
    }
  };

  const handleEditOrder = () => {
    setIsEditing(true);
    if (selectedOrder) {
      setEditedTotal(selectedOrder.totalPrice.toString());
    }
  };

  const handleSaveTotal = async () => {
    if (!selectedOrder) return;
    
    const newTotal = parseFloat(editedTotal);
    if (isNaN(newTotal) || newTotal <= 0) {
      notify('Valor inválido', 'error');
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiService.updateOrderTotal(selectedOrder.id, newTotal);
      if (response.data) {
        if (onRefresh) onRefresh();
        notify('Valor atualizado com sucesso!', 'success');
        // Fechar modal e retornar para a lista
        setIsEditing(false);
        setSelectedOrder(null);
        setShowAddItem(false);
      }
    } catch (error: any) {
      notify(error.response?.data?.message || 'Erro ao atualizar valor', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddItem = async () => {
    if (!selectedOrder || !newItemProductId || newItemQuantity <= 0) {
      notify('Preencha todos os campos', 'error');
      return;
    }

    setIsLoading(true);
    try {
      const product = products.find(p => p.id === newItemProductId);
      const price = newItemPrice ? parseFloat(newItemPrice) : (product?.price || 0);
      
      const response = await apiService.addItemToOrder(selectedOrder.id, {
        productId: newItemProductId,
        quantity: newItemQuantity,
        price: price
      });

      if (response.data) {
        if (onRefresh) onRefresh();
        notify('Item adicionado com sucesso!', 'success');
        // Fechar modal e retornar para a lista
        setIsEditing(false);
        setSelectedOrder(null);
        setShowAddItem(false);
        setNewItemProductId(0);
        setNewItemQuantity(1);
        setNewItemPrice('');
      }
    } catch (error: any) {
      notify(error.response?.data?.message || 'Erro ao adicionar item', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveItem = async (itemId: number) => {
    if (!selectedOrder) return;
    
    if (!window.confirm('Tem certeza que deseja remover este item?')) return;

    setIsLoading(true);
    try {
      const response = await apiService.removeItemFromOrder(selectedOrder.id, itemId);
      if (response.data) {
        if (onRefresh) onRefresh();
        notify('Item removido com sucesso!', 'success');
        // Fechar modal e retornar para a lista
        setIsEditing(false);
        setSelectedOrder(null);
        setShowAddItem(false);
      }
    } catch (error: any) {
      notify(error.response?.data?.message || 'Erro ao remover item', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!selectedOrder) return;
    
    if (!window.confirm('Tem certeza que deseja cancelar este pedido?')) return;

    setIsLoading(true);
    try {
      const response = await apiService.cancelOrder(selectedOrder.id);
      if (response.data) {
        if (onRefresh) onRefresh();
        notify('Pedido cancelado com sucesso!', 'success');
        // Fechar modal e retornar para a lista
        setIsEditing(false);
        setSelectedOrder(null);
        setShowAddItem(false);
      }
    } catch (error: any) {
      notify(error.response?.data?.message || 'Erro ao cancelar pedido', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteOrder = async () => {
    if (!showDeleteConfirm) return;

    setIsLoading(true);
    try {
      await apiService.deleteOrder(showDeleteConfirm.id);
      window.dispatchEvent(new CustomEvent('admin-order-deleted'));
      if (onRefresh) onRefresh();
      notify('Pedido excluído permanentemente com sucesso!', 'success');
      setShowDeleteConfirm(null);
      // Se o pedido excluído estava sendo visualizado, fechar o modal
      if (selectedOrder?.id === showDeleteConfirm.id) {
        setIsEditing(false);
        setSelectedOrder(null);
        setShowAddItem(false);
      }
    } catch (error: any) {
      notify(error.response?.data?.message || 'Erro ao excluir pedido', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Função para verificar se uma data é hoje
  const isToday = (date: string) => {
    const orderDate = new Date(date);
    const today = new Date();
    orderDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    return orderDate.getTime() === today.getTime();
  };

  // Função para verificar se uma data é esta semana
  const isThisWeek = (date: string) => {
    const orderDate = new Date(date);
    const today = new Date();
    const dayOfWeek = today.getDay();
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - dayOfWeek);
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    return orderDate >= startOfWeek && orderDate <= endOfWeek;
  };

  // Função para calcular tempo decorrido e restante com sistema de semáforo
  const getOrderTimeInfo = (order: Order) => {
    // Pedidos com conta fechada (mesa) não entram na contagem do timer
    if (order.status === 'closed') {
      return {
        elapsedMinutes: 0,
        remainingMinutes: 0,
        isOverdue: false,
        needsAttention: false,
        isNormal: true,
        trafficLightStage: 'green' as const,
        message: 'Conta fechada',
        elapsedTime: '-',
        remainingTime: '-',
        clockDisplay: '--:--:--'
      };
    }

    const timerStartIso = order.preparationStartedAt || order.createdAt;
    const orderDate = new Date(timerStartIso);
    const now = currentTime;
    const elapsedMs = now.getTime() - orderDate.getTime();
    const elapsedMinutes = Math.floor(elapsedMs / (1000 * 60));
    const estimateMinutes = parseInt(deliveryEstimate) || 45;
    const totalEstimateMs = estimateMinutes * 60 * 1000;
    const remainingMs = Math.max(0, totalEstimateMs - elapsedMs);
    const overrunMs = Math.max(0, elapsedMs - totalEstimateMs);
    const remainingMinutes = Math.max(0, estimateMinutes - elapsedMinutes);
    
    // Sistema de semáforo com 3 estágios
    const halfTime = estimateMinutes / 2; // Metade do tempo estimado
    const isOverdue = elapsedMinutes > estimateMinutes; // Vermelho: tempo esgotado
    const needsAttention = elapsedMinutes >= halfTime && elapsedMinutes <= estimateMinutes; // Amarelo: na metade do tempo
    const isNormal = elapsedMinutes < halfTime; // Verde: tempo normal
    
    // Determinar estágio do semáforo
    let trafficLightStage: 'green' | 'yellow' | 'red' = 'green';
    let message = '';
    
    if (isOverdue) {
      trafficLightStage = 'red';
      message = 'Pedido Atrasado';
    } else if (needsAttention) {
      trafficLightStage = 'yellow';
      message = 'Pedido Precisa de Atenção';
    } else {
      trafficLightStage = 'green';
      message = 'No prazo';
    }

    const clockDisplay = isOverdue ? formatMsToClock(overrunMs) : formatMsToClock(remainingMs);

    return {
      elapsedMinutes,
      remainingMinutes,
      isOverdue,
      needsAttention,
      isNormal,
      trafficLightStage,
      message,
      elapsedTime: formatTime(elapsedMinutes),
      remainingTime: formatTime(remainingMinutes),
      clockDisplay
    };
  };

  /** Exibe duração em ms como HH:MM:SS (atualiza a cada segundo com currentTime). */
  const formatMsToClock = (ms: number): string => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // Função para formatar tempo em minutos para string legível
  const formatTime = (minutes: number): string => {
    if (minutes < 60) {
      return `${minutes}min`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}min` : `${hours}h`;
  };

  // Pedidos filtrados e ordenados por prioridade (mais antigos primeiro)
  const filteredOrders = useMemo(() => {
    const filtered = orders.filter(order => {
      // Filtro por data
      let dateMatch = true;
      if (dateFilter === 'today') {
        dateMatch = isToday(order.createdAt);
      } else if (dateFilter === 'week') {
        dateMatch = isThisWeek(order.createdAt);
      }

      // Filtro por tipo de pedido
      let typeMatch = true;
      if (typeFilter === 'delivery') {
        // Mostrar apenas entrega e retirada (não mesa)
        typeMatch = order.deliveryType === 'delivery' || order.deliveryType === 'pickup';
      } else if (typeFilter === 'mesa') {
        // Mostrar apenas pedidos de mesa
        typeMatch = order.deliveryType === 'dine_in';
      }
      // Se typeFilter === 'all', não filtra por tipo

      return dateMatch && typeMatch;
    });

    return filtered;
  }, [orders, dateFilter, typeFilter]);

  const ordersPendingPayment = useMemo(
    () => sortOrdersOldestFirst(filteredOrders.filter((o) => ['pending_payment', 'canceled'].includes(o.status))),
    [filteredOrders]
  );
  const ordersPreparing = useMemo(
    () => sortPreparingOrdersMesaFirst(filteredOrders.filter((o) => o.status === 'being_prepared')),
    [filteredOrders]
  );
  const ordersFinalPhase = useMemo(
    () =>
      sortFinalPhaseOrders(
        filteredOrders.filter((o) =>
          ['on_the_way', 'ready_for_pickup', 'delivered', 'closed'].includes(o.status)
        )
      ),
    [filteredOrders]
  );

  const orderCountByUserId = useMemo(() => {
    const map = new Map<number, number>();
    for (const o of orders) {
      if (o.user?.username === 'USUARIO_BALCAO') continue;
      const uid = o.userId;
      if (typeof uid !== 'number' || Number.isNaN(uid)) continue;
      map.set(uid, (map.get(uid) || 0) + 1);
    }
    return map;
  }, [orders]);

  // Limpar todos os filtros (exceto data 'today' e tipo 'todos')
  const clearFilters = () => {
    setDateFilter('today'); // Sempre manter como 'today'
    setTypeFilter('all');
  };

  // Função para formatar valores em Real brasileiro
  const formatCurrencyBR = (value: number): string => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL'
    }).format(value);
  };

  const getOrderSubtotal = (order: Order): number => {
    const total = Number(order.totalPrice) || 0;
    const deliveryFee = order.deliveryType === 'delivery' ? Number(order.deliveryFee || 0) : 0;
    return Math.max(total - deliveryFee, 0);
  };

  // Contar filtros ativos (considerando 'today' e tipo 'all' como padrão)
  const activeFiltersCount = (dateFilter !== 'today' && dateFilter !== 'all' ? 1 : 0) + (typeFilter !== 'all' ? 1 : 0);

  // Calcular métricas baseado no período selecionado
  const metrics = useMemo(() => {
    let filteredOrdersForMetrics = orders;

    // Filtrar por período se não for "all"
    if (dateFilter === 'today') {
      filteredOrdersForMetrics = orders.filter(order => isToday(order.createdAt));
    } else if (dateFilter === 'week') {
      filteredOrdersForMetrics = orders.filter(order => isThisWeek(order.createdAt));
    }

    const totalValue = filteredOrdersForMetrics
      .filter(order => order.status !== 'canceled')
      .reduce((sum, order) => sum + Number(order.totalPrice), 0);

    // Determinar o label do período
    const periodLabel = dateFilter === 'today' ? 'Hoje' : 
                       dateFilter === 'week' ? 'Esta Semana' : 
                       'Geral';

    return {
      totalOrders: filteredOrdersForMetrics.length,
      totalValue,
      totalOrdersAll: orders.length,
      periodLabel
    };
  }, [orders, dateFilter]);

  const renderOrderCard = (order: Order) => {
            const timeInfo = getOrderTimeInfo(order);
            const isActiveOrder = order.status !== 'delivered' && order.status !== 'canceled' && order.status !== 'closed';
            const isPedidoUsuarioBalcao = order.user?.username === 'USUARIO_BALCAO';
            const delivererName =
              order.delivererName ||
              (order as any).deliverer?.name ||
              (order as any).deliverer?.nome ||
              null;
            const pedidosDoCliente =
              isPedidoUsuarioBalcao
                ? null
                : typeof order.userId === 'number' && !Number.isNaN(order.userId)
                  ? orderCountByUserId.get(order.userId) ?? 1
                  : null;
            
            return (
              <div
                key={order.id}
                className={`bg-white rounded-xl shadow-sm border overflow-hidden transition-all hover:shadow-md ${
                  order.status === 'canceled' 
                    ? 'border-red-200 opacity-70' 
                    : order.status === 'closed'
                    ? 'border-slate-200 opacity-90'
                    : order.status === 'pending_payment'
                    ? 'border-slate-100'
                    : order.status === 'ready_for_pickup'
                    ? 'border-slate-100'
                    : timeInfo.trafficLightStage === 'red' && isActiveOrder
                    ? 'border-red-500 border-2 bg-red-50'
                    : timeInfo.trafficLightStage === 'yellow' && isActiveOrder
                    ? 'border-yellow-500 border-2 bg-yellow-50'
                    : timeInfo.trafficLightStage === 'green' && isActiveOrder
                    ? 'border-green-300 border-2 bg-green-50'
                    : 'border-slate-100'
                }`}
              >
                <div className="px-4 py-3 space-y-2">
                  {/* Pedido #X | status */}
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm sm:text-base font-bold tabular-nums text-slate-900 leading-snug min-w-0">
                      Pedido #{order.dailyNumber ?? order.id}
                    </h3>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className={`px-2 py-1 text-[10px] font-bold rounded-full whitespace-nowrap ${getStatusStyle(order.status)}`}>
                        {getStatusInPortuguese(order.status)}
                      </span>
                      <button
                        type="button"
                        data-order-card-menu
                        onClick={(e) => {
                          e.stopPropagation();
                          if (cardMenuOrderId === order.id) {
                            closeCardMenu();
                          } else {
                            setCardMenuOrderId(order.id);
                            setCardMenuAnchor(e.currentTarget.getBoundingClientRect());
                          }
                        }}
                        className="p-1 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800 border border-transparent hover:border-slate-200 transition-colors"
                        title="Mais opções"
                        aria-expanded={cardMenuOrderId === order.id}
                        aria-haspopup="menu"
                      >
                        <MoreVertical className="w-4 h-4" strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>

                  {/* Data e hora */}
                  <p className="text-sm text-slate-600">
                    {new Date(order.createdAt).toLocaleString('pt-BR', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </p>
                  {order.criadoPorGarcomNome && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-md w-fit">
                      <UtensilsCrossed className="w-3 h-3 shrink-0" />
                      Garçom: {order.criadoPorGarcomNome}
                    </span>
                  )}

                  {/* Timer HH:MM:SS — restante (verde/amarelo) ou tempo de atraso (vermelho) */}
                  {isActiveOrder && deliveryEstimate && order.status !== 'ready_for_pickup' && order.status !== 'pending_payment' && (
                    <div className="w-full">
                      <div
                        className={`flex w-full items-center justify-center rounded-md border py-1 px-2 text-sm font-semibold tabular-nums tracking-wide font-mono ${
                          timeInfo.trafficLightStage === 'red'
                            ? 'bg-red-100 text-red-900 border-red-400'
                            : timeInfo.trafficLightStage === 'yellow'
                              ? 'bg-amber-100 text-amber-950 border-amber-400'
                              : 'bg-emerald-100 text-emerald-950 border-emerald-400'
                        }`}
                      >
                        {timeInfo.clockDisplay}
                      </div>
                    </div>
                  )}

                  {/* Nome do cliente | valor */}
                  <div className="flex items-start justify-between gap-3 pt-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs sm:text-sm font-semibold text-slate-900 break-words">
                        {(order as any).nomeClienteAvulso || order.user?.username || 'Cliente'}
                        {order.deliveryType === 'dine_in' && order.mesaNome && String(order.mesaNome).trim() && (
                          <span className="text-slate-600 font-medium ml-1">
                            ({order.mesaNome.trim()})
                          </span>
                        )}
                        {order.deliveryType === 'dine_in' &&
                          (!order.mesaNome || !String(order.mesaNome).trim()) &&
                          (order as any).identificadorMesaSenha && (
                          <span className="text-slate-500 font-medium ml-1">
                            ({(order as any).identificadorMesaSenha})
                          </span>
                        )}
                        {pedidosDoCliente !== null && (
                          <span
                            className="inline-flex items-center justify-center ml-1.5 align-middle text-[11px] font-bold tabular-nums text-slate-700 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5"
                            title={`${pedidosDoCliente} ${pedidosDoCliente === 1 ? 'pedido' : 'pedidos'} deste cliente nesta lista`}
                          >
                            {pedidosDoCliente}
                          </span>
                        )}
                      </p>
                    </div>
                    <p className="text-lg font-bold text-slate-900 shrink-0 tabular-nums">
                      {formatCurrencyBR(Number(order.totalPrice))}
                    </p>
                  </div>
                  {(() => {
                    const paymentInfo = getPaymentDisplay(order);
                    if (!paymentInfo) return null;
                    return (
                      <div className="pt-0.5">
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${paymentInfo.className}`}
                        >
                          {paymentInfo.label}
                        </span>
                      </div>
                    );
                  })()}

                  {(order.notes && order.notes.trim()) || order.precisaTroco ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {order.notes && order.notes.trim() && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-yellow-700 bg-yellow-50 px-1.5 py-0.5 rounded border border-yellow-200">
                          📝 Obs
                        </span>
                      )}
                      {order.precisaTroco && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-orange-700 bg-orange-50 px-1.5 py-0.5 rounded border border-orange-200">
                          💰 Troco
                        </span>
                      )}
                    </div>
                  ) : null}

                  {/* Tipo de entrega | ações */}
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-100">
                    <div className="min-w-0">
                      {order.deliveryType === 'delivery' && delivererName && (
                        <p className="text-[11px] font-medium text-slate-600 truncate mb-0.5">
                          Entregador: <span className="font-semibold text-slate-800">{delivererName}</span>
                        </p>
                      )}
                      {order.deliveryType === 'delivery' ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-blue-600">
                          <Truck className="w-3.5 h-3.5 shrink-0" /> Entrega
                        </span>
                      ) : order.deliveryType === 'dine_in' ? (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-purple-600">
                          <UtensilsCrossed className="w-3.5 h-3.5 shrink-0" /> Mesa
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-green-600">
                          <MapPin className="w-3.5 h-3.5 shrink-0" /> Retirada
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setSelectedOrder(order)}
                        className="p-2 text-slate-400 rounded-lg hover:bg-slate-100 hover:text-brand transition-colors"
                        title="Ver Detalhes"
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await sendPrintOrderJob({
                              order,
                              user: order.user
                                ? {
                                    nomeUsuario: order.user.username,
                                    telefone: (order.user as any).telefone || (order.user as any).phone,
                                    email: (order.user as any).email
                                  }
                                : undefined,
                              flavors: flavors,
                              customerOrderCount:
                                order.user?.username === 'USUARIO_BALCAO' ||
                                typeof order.userId !== 'number' ||
                                Number.isNaN(order.userId)
                                  ? undefined
                                  : orderCountByUserId.get(order.userId) ?? 1
                            });
                            notify('Enviado para impressão', 'success');
                          } catch (err: any) {
                            notify(err?.message || 'Falha ao enviar para impressão', 'error');
                          }
                        }}
                        className="p-2 text-slate-400 rounded-lg hover:bg-blue-50 hover:text-blue-600 transition-colors"
                        title="Imprimir"
                      >
                        <Printer className="w-4 h-4" />
                      </button>
                      {order.status === 'on_the_way' && order.deliveryType === 'delivery' && onReassignDeliverer && (
                        <button
                          type="button"
                          onClick={() => onReassignDeliverer(order)}
                          className="p-2 text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors"
                          title="Trocar entregador (reenvia WhatsApp)"
                        >
                          <Truck className="w-4 h-4" />
                        </button>
                      )}
                      {order.status !== 'delivered' && order.status !== 'canceled' && order.status !== 'closed' && (
                        <button
                          type="button"
                          onClick={() => handleAdvanceStatus(order)}
                          className="p-2 text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors"
                          title="Avançar Status"
                        >
                          <ArrowRightCircle className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
  };

  return (
    <div id="pedidos" className="page">
      {/* Cabeçalho */}
      <header className="mb-3 sm:mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
          <div className="flex-1">
            <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-slate-800 mb-1">Pedidos</h2>
            <p className="text-xs sm:text-sm text-slate-500">
              Gerencie os pedidos recebidos.
              {filteredOrders.length !== orders.length && (
                <span className="ml-2 text-brand font-medium">
                  {filteredOrders.length} de {orders.length} pedidos
                </span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/admin/novo-pedido-balcao')}
              className="bg-green-600 text-white px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 hover:bg-green-700 transition-colors whitespace-nowrap text-xs sm:text-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              Novo Pedido
            </button>
            <button 
              onClick={handleRefresh}
              disabled={isRefreshing}
              className={`bg-brand text-white px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 hover:bg-brand transition-colors whitespace-nowrap text-xs sm:text-sm ${
                isRefreshing ? 'opacity-75 cursor-not-allowed' : ''
              }`}
            >
              <RotateCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? 'Atualizando...' : 'Atualizar'}
            </button>
          </div>
        </div>
      </header>

      {/* Painel unificado: métricas + filtros */}
      <div className="bg-white p-3 rounded-xl shadow-sm border border-slate-100 mb-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {/* Total de Pedidos */}
          <div className="bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
            <div className="min-w-0">
              <h3 className="text-[11px] text-slate-600 leading-tight">Pedidos {metrics.periodLabel}</h3>
              <p className="text-lg sm:text-xl font-bold text-slate-800 leading-tight">{metrics.totalOrders}</p>
            </div>
          </div>

          {/* Total Geral */}
          <div className="bg-slate-50 px-3 py-2 rounded-lg border border-slate-200">
            <div className="min-w-0">
              <h3 className="text-[11px] text-slate-600 leading-tight">Total de Pedidos</h3>
              <p className="text-lg sm:text-xl font-bold text-slate-800 leading-tight">{metrics.totalOrdersAll}</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
          <div className="flex-1 grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setTypeFilter('all')}
              className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors inline-flex items-center justify-center gap-1.5 ${
                typeFilter === 'all'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              Todos
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('mesa')}
              className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors inline-flex items-center justify-center gap-1.5 ${
                typeFilter === 'mesa'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Store className="w-4 h-4" />
              Salão
            </button>
            <button
              type="button"
              onClick={() => setTypeFilter('delivery')}
              className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors inline-flex items-center justify-center gap-1.5 ${
                typeFilter === 'delivery'
                  ? 'bg-brand text-white border-brand'
                  : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              <Truck className="w-4 h-4" />
              Delivery
            </button>
          </div>

          <div className="relative sm:w-56">
            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="w-full px-3 py-2 pr-10 border border-slate-200 rounded-lg focus:ring-2 focus:ring-brand focus:border-brand appearance-none bg-white text-sm text-slate-700 cursor-pointer"
            >
              <option value="all">Todos os períodos</option>
              <option value="today">Hoje</option>
              <option value="week">Esta semana</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>

          {activeFiltersCount > 0 && (
            <button
              onClick={clearFilters}
              className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 transition-colors whitespace-nowrap"
            >
              <X className="w-3.5 h-3.5" />
              Limpar
            </button>
          )}
          {filteredOrders.length !== orders.length && (
            <span className="text-xs text-slate-500 whitespace-nowrap self-center">
              {filteredOrders.length} de {orders.length}
            </span>
          )}
        </div>
      </div>

      {/* Lista de Pedidos — no mobile/tablet alterna seção; desktop mostra as três */}
      <div className="space-y-4">
        <div className="lg:hidden rounded-xl border border-slate-200 bg-white p-1.5">
          <div className="grid grid-cols-3 gap-1">
            <button
              type="button"
              onClick={() => setMobileSection('pending')}
              aria-pressed={mobileSection === 'pending'}
              className={`rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors ${
                mobileSection === 'pending'
                  ? 'bg-yellow-300 text-yellow-950 border border-yellow-500'
                  : 'bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200'
              }`}
            >
              Pendentes ({ordersPendingPayment.length})
            </button>
            <button
              type="button"
              onClick={() => setMobileSection('preparing')}
              aria-pressed={mobileSection === 'preparing'}
              className={`rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors ${
                mobileSection === 'preparing'
                  ? 'bg-blue-300 text-blue-950 border border-blue-500'
                  : 'bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200'
              }`}
            >
              Preparo ({ordersPreparing.length})
            </button>
            <button
              type="button"
              onClick={() => setMobileSection('final')}
              aria-pressed={mobileSection === 'final'}
              className={`rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors ${
                mobileSection === 'final'
                  ? 'bg-emerald-300 text-emerald-950 border border-emerald-500'
                  : 'bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200'
              }`}
            >
              Final ({ordersFinalPhase.length})
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 items-stretch divide-y lg:divide-y-0 lg:divide-x divide-slate-400 rounded-xl overflow-hidden border-2 border-slate-500 shadow-md">
          <section
            className={`${mobileSection === 'pending' ? 'flex' : 'hidden'} lg:flex flex-col bg-yellow-200 h-[min(70vh,52rem)] shrink-0`}
            aria-labelledby="admin-orders-pending"
          >
            <div className="px-3 py-2 sm:py-2.5 border-b-2 border-yellow-500 bg-yellow-300 shrink-0 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 id="admin-orders-pending" className="text-sm font-bold text-yellow-950">
                  Pagamento pendente/cancelados
                </h3>
                <p className="text-[11px] text-yellow-950">Mais antigos no topo</p>
              </div>
              <span
                className="shrink-0 inline-flex min-w-[2rem] items-center justify-center rounded-md border-2 border-yellow-700 bg-yellow-400 px-2 py-1 text-sm font-bold tabular-nums text-yellow-950"
                aria-label={`${ordersPendingPayment.length} pedidos nesta etapa`}
              >
                {ordersPendingPayment.length}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0 bg-yellow-200">
              {ordersPendingPayment.length === 0 ? (
                <p className="text-center text-xs text-yellow-950/80 py-8 px-2">Nenhum pedido nesta etapa</p>
              ) : (
                ordersPendingPayment.map(renderOrderCard)
              )}
            </div>
          </section>

          <section
            className={`${mobileSection === 'preparing' ? 'flex' : 'hidden'} lg:flex flex-col bg-blue-200 h-[min(70vh,52rem)] shrink-0`}
            aria-labelledby="admin-orders-prep"
          >
            <div className="px-3 py-2 sm:py-2.5 border-b-2 border-blue-500 bg-blue-300 shrink-0 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 id="admin-orders-prep" className="text-sm font-bold text-blue-950">
                  Em preparo
                </h3>
                <p className="text-[11px] text-blue-950">Mais antigos no topo</p>
              </div>
              <span
                className="shrink-0 inline-flex min-w-[2rem] items-center justify-center rounded-md border-2 border-blue-700 bg-blue-400 px-2 py-1 text-sm font-bold tabular-nums text-blue-950"
                aria-label={`${ordersPreparing.length} pedidos nesta etapa`}
              >
                {ordersPreparing.length}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0 bg-blue-200">
              {ordersPreparing.length === 0 ? (
                <p className="text-center text-xs text-blue-950/80 py-8 px-2">Nenhum pedido nesta etapa</p>
              ) : (
                ordersPreparing.map(renderOrderCard)
              )}
            </div>
          </section>

          <section
            className={`${mobileSection === 'final' ? 'flex' : 'hidden'} lg:flex flex-col bg-emerald-200 h-[min(70vh,52rem)] shrink-0`}
            aria-labelledby="admin-orders-final"
          >
            <div className="px-3 py-2 sm:py-2.5 border-b-2 border-emerald-500 bg-emerald-300 shrink-0 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 id="admin-orders-final" className="text-sm font-bold text-emerald-950">
                  Prontos/concluídos
                </h3>
                <p className="text-[11px] text-emerald-950">Mais antigos no topo</p>
              </div>
              <span
                className="shrink-0 inline-flex min-w-[2rem] items-center justify-center rounded-md border-2 border-emerald-700 bg-emerald-400 px-2 py-1 text-sm font-bold tabular-nums text-emerald-950"
                aria-label={`${ordersFinalPhase.length} pedidos nesta etapa`}
              >
                {ordersFinalPhase.length}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0 bg-emerald-200">
              {ordersFinalPhase.length === 0 ? (
                <p className="text-center text-xs text-emerald-950/80 py-8 px-2">Nenhum pedido nesta etapa</p>
              ) : (
                ordersFinalPhase.map(renderOrderCard)
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Modal de Detalhes do Pedido */}
      {selectedOrder && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-2 sm:p-4">
          <div className="bg-slate-50 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[95vh] sm:max-h-[90vh] overflow-y-auto ring-1 ring-slate-200/60">
            {/* Header do Modal */}
            <div className="sticky top-0 bg-white border-b border-slate-200 px-4 sm:px-5 py-3 sm:py-4 z-10">
              <div className="flex items-start sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="hidden sm:flex w-10 h-10 rounded-xl bg-brand/10 text-brand items-center justify-center flex-shrink-0">
                    <Hash className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-base sm:text-lg md:text-xl font-bold text-slate-900 truncate">
                        Pedido #{selectedOrder.dailyNumber ?? selectedOrder.id}
                      </h2>
                      <span className={`inline-flex items-center px-2 py-0.5 text-[10px] sm:text-xs font-semibold rounded-full ${getStatusStyle(selectedOrder.status)}`}>
                        {getStatusInPortuguese(selectedOrder.status)}
                      </span>
                    </div>
                    <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                      {new Date(selectedOrder.createdAt).toLocaleString('pt-BR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!isEditing && (
                    <button
                      onClick={handleEditOrder}
                      className="p-2 text-slate-500 hover:text-brand hover:bg-brand/5 rounded-lg transition-colors"
                      title="Editar Pedido"
                    >
                      <Edit className="w-4 h-4 sm:w-5 sm:h-5" />
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setIsEditing(false);
                      setSelectedOrder(null);
                      setShowAddItem(false);
                    }}
                    className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                    title="Fechar"
                  >
                    <X className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Conteúdo do Modal */}
            <div className="p-3 sm:p-4 md:p-5 space-y-3 sm:space-y-4">
              {/* Cliente + Tipo de entrega + Pagamento (cartão principal) */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-3 sm:px-4 py-2 border-b border-slate-100 flex items-center gap-2">
                  <User className="w-4 h-4 text-slate-500" />
                  <h3 className="text-xs sm:text-sm font-semibold text-slate-700 uppercase tracking-wide">
                    Cliente
                  </h3>
                </div>
                <div className="p-3 sm:p-4 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center flex-shrink-0">
                        <User className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] sm:text-xs text-slate-500 leading-none">Nome</p>
                        <p className="font-semibold text-slate-900 text-sm break-words mt-0.5">
                          {(selectedOrder as any).nomeClienteAvulso || selectedOrder.user?.username || '-'}
                        </p>
                        {selectedOrder.deliveryType === 'dine_in' && (
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            {selectedOrder.mesaNome && String(selectedOrder.mesaNome).trim()
                              ? selectedOrder.mesaNome.trim()
                              : (selectedOrder as any).identificadorMesaSenha || ''}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center flex-shrink-0">
                        <Phone className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] sm:text-xs text-slate-500 leading-none">Telefone</p>
                        <p className="font-semibold text-slate-900 text-sm mt-0.5 break-all">
                          {(selectedOrder.user as any)?.telefone || (selectedOrder.user as any)?.phone || '-'}
                        </p>
                      </div>
                    </div>
                  </div>

                  {selectedOrder.criadoPorGarcomNome && (
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-violet-50 border border-violet-200 rounded-full text-xs">
                      <UtensilsCrossed className="w-3.5 h-3.5 text-violet-600" />
                      <span className="text-violet-700 font-medium">Garçom:</span>
                      <span className="text-violet-900 font-semibold">{selectedOrder.criadoPorGarcomNome}</span>
                    </div>
                  )}

                  {(selectedOrder.user as any)?.enderecos && (selectedOrder.user as any).enderecos.length > 0 && (
                    <div className="flex items-start gap-2.5 p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                      <div className="w-8 h-8 rounded-full bg-brand/10 text-brand flex items-center justify-center flex-shrink-0">
                        <MapPin className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[10px] sm:text-xs text-slate-500 leading-none">Endereço principal</p>
                        <p className="font-semibold text-slate-900 text-xs sm:text-sm break-words mt-0.5">
                          {(selectedOrder.user as any).enderecos[0].street}, {(selectedOrder.user as any).enderecos[0].number}
                          {(selectedOrder.user as any).enderecos[0].complement && ` - ${(selectedOrder.user as any).enderecos[0].complement}`}
                        </p>
                        <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                          {(selectedOrder.user as any).enderecos[0].neighborhood}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Tipo de Entrega + Forma de Pagamento (lado a lado) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4">
                  <p className="text-[10px] sm:text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">
                    Tipo de entrega
                  </p>
                  {selectedOrder.deliveryType === 'delivery' ? (
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center">
                        <Truck className="w-4 h-4" />
                      </div>
                      <span className="font-bold text-blue-700 text-sm sm:text-base">Entrega</span>
                    </div>
                  ) : selectedOrder.deliveryType === 'dine_in' ? (
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center">
                        <UtensilsCrossed className="w-4 h-4" />
                      </div>
                      <span className="font-bold text-purple-700 text-sm sm:text-base">Mesa</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
                        <Store className="w-4 h-4" />
                      </div>
                      <span className="font-bold text-emerald-700 text-sm sm:text-base">Retirada</span>
                    </div>
                  )}
                </div>
                <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4">
                  <p className="text-[10px] sm:text-xs text-slate-500 uppercase tracking-wide font-semibold mb-2">
                    Forma de pagamento
                  </p>
                  {(selectedOrder as any).paymentMethod === 'CREDIT_CARD' && (
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center">
                        <CreditCard className="w-4 h-4" />
                      </div>
                      <span className="font-bold text-purple-700 text-sm sm:text-base">Cartão de Crédito</span>
                    </div>
                  )}
                  {(selectedOrder as any).paymentMethod === 'PIX' && (
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center">
                        <Smartphone className="w-4 h-4" />
                      </div>
                      <span className="font-bold text-emerald-700 text-sm sm:text-base">PIX</span>
                    </div>
                  )}
                  {(selectedOrder as any).paymentMethod === 'CASH_ON_DELIVERY' && (
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center">
                        <DollarSign className="w-4 h-4" />
                      </div>
                      <span className="font-bold text-amber-700 text-sm sm:text-base">Dinheiro</span>
                    </div>
                  )}
                  {!(selectedOrder as any).paymentMethod && (
                    <div className="flex items-center gap-2">
                      <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center">
                        <AlertCircle className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="font-semibold text-slate-600 text-sm">Não registrado</p>
                        <p className="text-[10px] text-slate-400">(pedido antigo)</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Informação de Troco */}
              {selectedOrder.paymentMethod === 'CASH_ON_DELIVERY' && selectedOrder.precisaTroco && (
                <div className="bg-amber-50 rounded-xl p-3 sm:p-4 border border-amber-200 flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                    <DollarSign className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs sm:text-sm font-bold text-amber-900">Troco necessário</p>
                    {selectedOrder.valorTroco ? (
                      <div className="mt-1 text-xs sm:text-sm">
                        <p className="text-slate-700">
                          Cliente pagará com{' '}
                          <span className="font-bold text-amber-800">
                            R$ {Number(selectedOrder.valorTroco).toFixed(2)}
                          </span>
                        </p>
                        <p className="text-slate-600 mt-0.5">
                          Troco de{' '}
                          <span className="font-semibold text-slate-800">
                            R$ {(Number(selectedOrder.valorTroco) - Number(selectedOrder.totalPrice)).toFixed(2)}
                          </span>
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs sm:text-sm text-slate-700 mt-0.5">
                        Cliente precisa de troco (valor não informado).
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Itens do Pedido */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-3 sm:px-4 py-2 border-b border-slate-100 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Package className="w-4 h-4 text-slate-500" />
                    <h3 className="text-xs sm:text-sm font-semibold text-slate-700 uppercase tracking-wide">
                      Itens do pedido
                    </h3>
                  </div>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-[10px] sm:text-xs font-semibold">
                    {(selectedOrder.orderitem || []).length} {(selectedOrder.orderitem || []).length === 1 ? 'item' : 'itens'}
                  </span>
                </div>
                <div className="p-2 sm:p-3 space-y-2">
                  {(selectedOrder.orderitem || []).map(item => {
                    const isCustomAcai = item.selectedOptionsSnapshot?.customAcai;
                    const isCustomSorvete = item.selectedOptionsSnapshot?.customSorvete;
                    const isCustomProduct = item.selectedOptionsSnapshot?.customProduct;
                    const customData = isCustomAcai || isCustomSorvete || isCustomProduct;
                    const additionalsTotal = Array.isArray((item as any).additionals)
                      ? (item as any).additionals.reduce((acc: number, a: any) => acc + (Number(a.value || 0) * Number(a.quantity || 0)), 0)
                      : 0;
                    const unitPrice = Number(item.priceAtOrder || 0) + additionalsTotal;
                    
                    if (!item.product) return null;
                    
                    return (
                      <div key={item.id} className="bg-slate-50 rounded-lg p-2.5 sm:p-3 border border-slate-200/70 hover:border-slate-300 transition-colors">
                        <div className="flex items-start gap-2.5 sm:gap-3">
                          <div className="flex-shrink-0 w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-white border border-slate-200 text-slate-700 flex items-center justify-center font-bold text-sm sm:text-base">
                            {item.quantity}×
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-start gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-semibold text-slate-900 text-xs sm:text-sm break-words leading-tight">
                                    {item.product.name}
                                  </span>
                                  {customData && (
                                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] sm:text-[10px] font-semibold flex-shrink-0 ${
                                      isCustomAcai ? 'bg-purple-100 text-purple-700' :
                                      isCustomSorvete ? 'bg-blue-100 text-blue-700' :
                                      'bg-emerald-100 text-emerald-700'
                                    }`}>
                                      Personalizado
                                    </span>
                                  )}
                                </div>
                                <p className="text-[10px] sm:text-xs text-slate-500 mt-0.5">
                                  R$ {unitPrice.toFixed(2)} cada
                                </p>
                              </div>
                              <p className="font-bold text-brand text-sm sm:text-base flex-shrink-0">
                                R$ {(unitPrice * item.quantity).toFixed(2)}
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Complementos de produtos personalizados */}
                        {customData && customData.complementNames && Array.isArray(customData.complementNames) && customData.complementNames.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-200/70">
                            <div className="flex items-center gap-2">
                              <p className="text-[10px] sm:text-xs font-semibold text-slate-500">Complementos</p>
                              <button
                                onClick={() => setShowComplementsModal({
                                  orderId: selectedOrder.id,
                                  itemId: item.id,
                                  complements: customData.complementNames.map((name: string, idx: number) => ({ id: idx, name }))
                                })}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] sm:text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 transition-colors"
                                title="Ver complementos"
                              >
                                <List className="w-3 h-3" />
                                <span>{customData.complementNames.length}</span>
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Complementos regulares do produto */}
                        {item.complements && item.complements.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-200/70">
                            <div className="flex items-center gap-2">
                              <p className="text-[10px] sm:text-xs font-semibold text-slate-500">Complementos</p>
                              <button
                                onClick={() => setShowComplementsModal({ orderId: selectedOrder.id, itemId: item.id, complements: item.complements || [] })}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] sm:text-xs bg-purple-50 text-purple-700 border border-purple-200 hover:bg-purple-100 transition-colors"
                                title="Ver complementos"
                              >
                                <List className="w-3 h-3" />
                                <span>{item.complements.length}</span>
                              </button>
                            </div>
                          </div>
                        )}

                        {/* Adicionais */}
                        {(item as any).additionals && (item as any).additionals.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-200/70">
                            <div className="flex items-start gap-2 flex-wrap">
                              <p className="text-[10px] sm:text-xs font-semibold text-slate-500 leading-5">Adicionais</p>
                              <div className="inline-flex items-center gap-1 flex-wrap">
                                {(item as any).additionals.map((a: any) => (
                                  <span
                                    key={a.id}
                                    className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] sm:text-xs bg-emerald-50 text-emerald-700 border border-emerald-200"
                                    title={a.name}
                                  >
                                    {a.quantity}× {a.name} (+{formatCurrencyBR(Number(a.value) || 0)})
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Sabores */}
                        {(() => {
                          const itemFlavors = getItemFlavors(item);
                          if (itemFlavors.length > 0) {
                            return (
                              <div className="mt-2 pt-2 border-t border-slate-200/70">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-[10px] sm:text-xs font-semibold text-slate-500 leading-5">Sabores</p>
                                  <div className="inline-flex items-center gap-1 flex-wrap">
                                    {itemFlavors.map((flavor) => (
                                      <span
                                        key={flavor.id}
                                        className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] sm:text-xs bg-pink-50 text-pink-700 border border-pink-200"
                                      >
                                        {flavor.name}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            );
                          }
                          return null;
                        })()}
                        {isEditing && (
                          <div className="mt-2 pt-2 border-t border-red-200">
                            <button
                              onClick={() => handleRemoveItem(item.id)}
                              disabled={isLoading}
                              className="w-full bg-red-500 text-white px-2.5 py-1.5 rounded-md text-xs font-semibold hover:bg-red-600 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              Remover item
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Observações do Pedido */}
              {selectedOrder.notes && selectedOrder.notes.trim() && (
                <div className="bg-amber-50 rounded-xl p-3 sm:p-4 border border-amber-200 flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
                    <StickyNote className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs sm:text-sm font-bold text-amber-900">Observações do cliente</p>
                    <p className="text-xs sm:text-sm text-slate-700 whitespace-pre-wrap break-words mt-1">
                      {selectedOrder.notes}
                    </p>
                  </div>
                </div>
              )}

              {/* Resumo Financeiro */}
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-3 sm:px-4 py-2 border-b border-slate-100 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Receipt className="w-4 h-4 text-slate-500" />
                    <h3 className="text-xs sm:text-sm font-semibold text-slate-700 uppercase tracking-wide">
                      Resumo financeiro
                    </h3>
                  </div>
                  {isEditing && (
                    <button
                      onClick={handleSaveTotal}
                      disabled={isLoading}
                      className="inline-flex items-center gap-1 text-xs bg-brand text-white px-2.5 py-1 rounded-md hover:bg-brand disabled:opacity-50"
                    >
                      <Save className="w-3.5 h-3.5" />
                      Salvar
                    </button>
                  )}
                </div>
                <div className="p-3 sm:p-4 space-y-1.5">
                  <div className="flex justify-between items-center text-slate-600 text-xs sm:text-sm">
                    <span>Subtotal</span>
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editedTotal}
                        onChange={(e) => setEditedTotal(e.target.value)}
                        className="w-28 px-2 py-1 text-xs border border-slate-300 rounded-md text-right focus:outline-none focus:ring-2 focus:ring-brand/30"
                      />
                    ) : (
                      <span className="font-semibold text-slate-800">
                        R$ {getOrderSubtotal(selectedOrder).toFixed(2)}
                      </span>
                    )}
                  </div>
                  {selectedOrder.deliveryType === 'delivery' && (
                    <div className="flex justify-between items-center text-slate-600 text-xs sm:text-sm">
                      <span>Taxa de entrega</span>
                      <span className="font-semibold text-slate-800">
                        R$ {Number(selectedOrder.deliveryFee || 0).toFixed(2)}
                      </span>
                    </div>
                  )}
                  <div className="border-t border-dashed border-slate-200 pt-2 mt-2 flex justify-between items-baseline">
                    <span className="text-sm sm:text-base font-bold text-slate-900">Total</span>
                    <span className="text-lg sm:text-xl font-extrabold text-brand">
                      R$ {isEditing ? Number(editedTotal || 0).toFixed(2) : Number(selectedOrder.totalPrice).toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Adicionar Item (modo edição) */}
              {isEditing && (
                <div className="bg-white rounded-xl border border-blue-200 overflow-hidden">
                  {!showAddItem ? (
                    <button
                      onClick={() => setShowAddItem(true)}
                      className="w-full px-3 py-2.5 text-blue-700 hover:bg-blue-50 font-semibold transition-colors flex items-center justify-center gap-2 text-xs sm:text-sm"
                    >
                      <Plus className="w-4 h-4" />
                      Adicionar item
                    </button>
                  ) : (
                    <div className="p-3 sm:p-4 space-y-2">
                      <h4 className="text-xs sm:text-sm font-bold text-slate-800">Adicionar novo item</h4>
                      <select
                        value={newItemProductId}
                        onChange={(e) => {
                          setNewItemProductId(Number(e.target.value));
                          const product = products.find(p => p.id === Number(e.target.value));
                          if (product) setNewItemPrice(product.price.toString());
                        }}
                        className="w-full px-2.5 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                      >
                        <option value={0}>Selecione um produto</option>
                        {products.map(product => (
                          <option key={product.id} value={product.id}>
                            {product.name} - R$ {product.price.toFixed(2)}
                          </option>
                        ))}
                      </select>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="number"
                          min="1"
                          value={newItemQuantity}
                          onChange={(e) => setNewItemQuantity(Number(e.target.value))}
                          placeholder="Quantidade"
                          className="px-2.5 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                        />
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={newItemPrice}
                          onChange={(e) => setNewItemPrice(e.target.value)}
                          placeholder="Preço"
                          className="px-2.5 py-1.5 text-xs sm:text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                        />
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={handleAddItem}
                          disabled={isLoading}
                          className="flex-1 bg-emerald-600 text-white px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                        >
                          Adicionar
                        </button>
                        <button
                          onClick={() => {
                            setShowAddItem(false);
                            setNewItemProductId(0);
                            setNewItemQuantity(1);
                            setNewItemPrice('');
                          }}
                          className="flex-1 bg-slate-200 text-slate-700 px-3 py-1.5 rounded-md text-xs sm:text-sm font-semibold hover:bg-slate-300"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer sticky com ações */}
            <div className="sticky bottom-0 bg-white border-t border-slate-200 px-3 sm:px-4 py-2.5 sm:py-3">
              {!isEditing ? (
                <div className="flex flex-col sm:flex-row gap-2">
                  {/* Ação primária */}
                  {(() => {
                    const isFinalStatus =
                      selectedOrder.status === 'delivered' ||
                      selectedOrder.status === 'canceled' ||
                      selectedOrder.status === 'closed';
                    return (
                      <button
                        onClick={() => handleAdvanceStatus(selectedOrder)}
                        disabled={isFinalStatus}
                        title={isFinalStatus ? `Pedido já está como "${getStatusInPortuguese(selectedOrder.status)}"` : 'Avançar status'}
                        className={`flex-1 px-3 sm:px-4 py-2.5 rounded-lg font-semibold transition-colors inline-flex items-center justify-center gap-2 text-sm shadow-sm ${
                          isFinalStatus
                            ? 'bg-slate-200 text-slate-400 cursor-not-allowed shadow-none'
                            : 'bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800'
                        }`}
                      >
                        <ArrowRightCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                        <span>{isFinalStatus ? getStatusInPortuguese(selectedOrder.status) : 'Avançar status'}</span>
                      </button>
                    );
                  })()}

                  {/* Ações secundárias */}
                  <div className="flex gap-1.5 flex-wrap sm:flex-nowrap">
                    {selectedOrder.status === 'on_the_way' && selectedOrder.deliveryType === 'delivery' && onReassignDeliverer && (
                      <button
                        type="button"
                        onClick={() => onReassignDeliverer(selectedOrder)}
                        className="flex-1 sm:flex-none px-3 py-2.5 rounded-lg font-medium border border-violet-200 bg-white text-violet-700 hover:bg-violet-50 transition-colors inline-flex items-center justify-center gap-1.5 text-xs sm:text-sm"
                        title="Trocar entregador"
                      >
                        <Truck className="w-4 h-4" />
                        <span className="sm:hidden md:inline">Entregador</span>
                      </button>
                    )}
                    <button
                      onClick={() => {
                        (async () => {
                          try {
                            await sendPrintOrderJob({
                              order: selectedOrder,
                              user: selectedOrder.user
                                ? {
                                    nomeUsuario: selectedOrder.user.username,
                                    telefone: (selectedOrder.user as any).telefone || (selectedOrder.user as any).phone,
                                    email: (selectedOrder.user as any).email
                                  }
                                : undefined,
                              flavors: flavors,
                              customerOrderCount:
                                selectedOrder.user?.username === 'USUARIO_BALCAO' ||
                                typeof selectedOrder.userId !== 'number' ||
                                Number.isNaN(selectedOrder.userId)
                                  ? undefined
                                  : orderCountByUserId.get(selectedOrder.userId) ?? 1
                            });
                            notify('Enviado para impressão', 'success');
                          } catch (err: any) {
                            notify(err?.message || 'Falha ao enviar para impressão', 'error');
                          }
                        })();
                      }}
                      className="flex-1 sm:flex-none px-3 py-2.5 rounded-lg font-medium border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 transition-colors inline-flex items-center justify-center gap-1.5 text-xs sm:text-sm"
                      title="Imprimir"
                    >
                      <Printer className="w-4 h-4" />
                      <span className="sm:hidden md:inline">Imprimir</span>
                    </button>
                    {selectedOrder.status !== 'canceled' &&
                     selectedOrder.status !== 'closed' &&
                     selectedOrder.status !== 'on_the_way' &&
                     selectedOrder.status !== 'ready_for_pickup' &&
                     selectedOrder.status !== 'delivered' && (
                      <button
                        onClick={handleCancelOrder}
                        disabled={isLoading}
                        className="flex-1 sm:flex-none px-3 py-2.5 rounded-lg font-medium border border-red-200 bg-white text-red-700 hover:bg-red-50 transition-colors inline-flex items-center justify-center gap-1.5 text-xs sm:text-sm disabled:opacity-50"
                        title="Cancelar pedido"
                      >
                        <X className="w-4 h-4" />
                        <span className="sm:hidden md:inline">Cancelar</span>
                      </button>
                    )}
                    <button
                      onClick={() => setShowDeleteConfirm(selectedOrder)}
                      disabled={isLoading}
                      className="flex-1 sm:flex-none px-3 py-2.5 rounded-lg font-medium border border-red-300 bg-red-600 text-white hover:bg-red-700 transition-colors inline-flex items-center justify-center gap-1.5 text-xs sm:text-sm disabled:opacity-50"
                      title="Excluir pedido"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span className="sm:hidden md:inline">Excluir</span>
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setIsEditing(false);
                    setShowAddItem(false);
                    setEditedTotal(selectedOrder.totalPrice.toString());
                  }}
                  className="w-full bg-slate-700 text-white px-3 py-2.5 rounded-lg font-semibold hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2 text-sm"
                >
                  <X className="w-4 h-4" />
                  <span>Sair da edição</span>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal de Complementos */}
      {showComplementsModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10020] p-4">
          <div className="bg-white p-4 sm:p-6 rounded-xl max-w-md w-full max-h-[80vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-base sm:text-lg font-semibold text-slate-800 flex items-center gap-2">
                <List className="w-5 h-5 text-purple-600" />
                Complementos
              </h3>
              <button 
                onClick={() => setShowComplementsModal(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="space-y-2">
              {showComplementsModal.complements.map((complement: any) => (
                <div
                  key={complement.id}
                  className="p-2 sm:p-3 bg-purple-50 border border-purple-200 rounded-lg"
                >
                  <span className="text-sm sm:text-base font-medium text-purple-800">
                    {complement.name}
                  </span>
                </div>
              ))}
            </div>

            <div className="mt-4 pt-4 border-t border-slate-200">
              <button
                onClick={() => setShowComplementsModal(null)}
                className="w-full px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand transition-colors text-sm font-medium"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Menu ⋮ do card (portal: não é cortado pela rolagem das colunas) */}
      {cardMenuOrderId != null &&
        cardMenuAnchor &&
        (() => {
          const menuOrder = orders.find((o) => o.id === cardMenuOrderId);
          if (!menuOrder) return null;
          const panelW = 176;
          const left = Math.max(8, Math.min(cardMenuAnchor.right - panelW, window.innerWidth - panelW - 8));
          return createPortal(
            <div
              data-order-card-menu
              role="menu"
              className="fixed z-[10050] min-w-[11rem] rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
              style={{ top: cardMenuAnchor.bottom + 4, left }}
            >
              <button
                type="button"
                role="menuitem"
                className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                onClick={() => {
                  closeCardMenu();
                  setSelectedOrder(menuOrder);
                }}
              >
                <Eye className="w-4 h-4 shrink-0 opacity-70" />
                Ver detalhes
              </button>
              <button
                type="button"
                role="menuitem"
                className="w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                onClick={() => {
                  closeCardMenu();
                  (async () => {
                    try {
                      await sendPrintOrderJob({
                        order: menuOrder,
                        user: menuOrder.user
                          ? {
                              nomeUsuario: menuOrder.user.username,
                              telefone: (menuOrder.user as any).telefone || (menuOrder.user as any).phone,
                              email: (menuOrder.user as any).email
                            }
                          : undefined,
                        flavors: flavors,
                        customerOrderCount:
                          menuOrder.user?.username === 'USUARIO_BALCAO' ||
                          typeof menuOrder.userId !== 'number' ||
                          Number.isNaN(menuOrder.userId)
                            ? undefined
                            : orderCountByUserId.get(menuOrder.userId) ?? 1
                      });
                      notify('Enviado para impressão', 'success');
                    } catch (err: any) {
                      notify(err?.message || 'Falha ao enviar para impressão', 'error');
                    }
                  })();
                }}
              >
                <Printer className="w-4 h-4 shrink-0 opacity-70" />
                Imprimir
              </button>
              <div className="my-1 h-px bg-slate-100" />
              <button
                type="button"
                role="menuitem"
                className="w-full px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                onClick={() => {
                  closeCardMenu();
                  setShowDeleteConfirm(menuOrder);
                }}
              >
                <Trash2 className="w-4 h-4 shrink-0" />
                Excluir pedido
              </button>
            </div>,
            document.body
          );
        })()}

      {/* Modal de Confirmação de Exclusão */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[10000] p-4">
          <div className="bg-white p-4 sm:p-6 rounded-xl max-w-md w-full">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg sm:text-xl font-bold text-slate-800 flex items-center gap-2">
                <AlertCircle className="w-6 h-6 text-red-600" />
                Excluir Pedido
              </h3>
              <button 
                onClick={() => setShowDeleteConfirm(null)}
                className="text-slate-400 hover:text-slate-600"
                disabled={isLoading}
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            <div className="mb-6">
              <p className="text-sm sm:text-base text-slate-700 mb-2">
                Tem certeza que deseja <strong className="text-red-600">excluir permanentemente</strong> o pedido <strong>#{showDeleteConfirm.id}</strong>?
              </p>
              <p className="text-xs sm:text-sm text-slate-500">
                Esta ação não pode ser desfeita. Todos os dados relacionados a este pedido serão removidos permanentemente.
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowDeleteConfirm(null)}
                disabled={isLoading}
                className="flex-1 px-4 py-2 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 transition-colors text-sm font-medium disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleDeleteOrder}
                disabled={isLoading}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <RotateCw className="w-4 h-4 animate-spin" />
                    Excluindo...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Excluir Permanentemente
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Pedidos;