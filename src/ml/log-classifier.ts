// Internal Log Classification using pattern matching and heuristics
// Zero-dependency implementation using statistical analysis

export interface MLClassifierOptions {
  enabled?: boolean;
  modelType?: 'naive-bayes' | 'pattern-matching' | 'heuristic';
  features?: string[]; // Fields to use as features
  categories?: string[]; // Categories to classify into
  trainingDataSize?: number; // Number of samples to keep for training
  retrainInterval?: number; // How often to retrain (ms)
  confidenceThreshold?: number; // Minimum confidence for classification
  onlineTraining?: boolean; // Whether to learn from new data
  persistModel?: boolean; // Whether to save/load model
  modelPath?: string; // Path to save/load model
}

export interface ClassificationResult {
  category: string;
  confidence: number;
  features: Record<string, number | boolean | string>;
  alternatives?: Array<{ category: string; confidence: number }>;
}

export interface LogFeatures {
  // Text features
  messageLength: number;
  wordCount: number;
  uppercaseRatio: number;
  numbersCount: number;
  specialCharsCount: number;
  
  // Content features
  hasError: boolean;
  hasWarning: boolean;
  hasIpAddress: boolean;
  hasEmail: boolean;
  hasUrl: boolean;
  hasPath: boolean;
  hasTimestamp: boolean;
  
  // Structural features
  levelNumeric: number;
  hasStructuredData: boolean;
  fieldsCount: number;
  nestingDepth: number;
  
  // Temporal features
  hour: number;
  dayOfWeek: number;
  isWeekend: boolean;
  
  // Performance features
  hasResponseTime: boolean;
  hasStatusCode: boolean;
  hasMemoryInfo: boolean;
  hasCpuInfo: boolean;
  
  // Security features
  hasSensitiveData: boolean;
  hasAuthData: boolean;
  hasFailedAuth: boolean;
  
  // Custom features
  [key: string]: number | boolean | string;
}

// Internal log data interface
interface LogData {
  level?: string;
  levelLabel?: string;
  msg?: string;
  message?: string;
  time?: number;
  error?: unknown;
  stack?: string;
  responseTime?: number;
  statusCode?: number;
  [key: string]: unknown;
}

// Simple statistical model interface
interface SimpleModel {
  categories: Map<string, CategoryModel>;
  totalSamples: number;
}

interface CategoryModel {
  count: number;
  features: Map<string, FeatureStats>;
  patterns: RegExp[];
}

interface FeatureStats {
  sum: number;
  count: number;
  min: number;
  max: number;
  mean: number;
}

export class LogClassifier {
  private options: Required<MLClassifierOptions>;
  private model: SimpleModel | null = null;
  private trainingData: Array<{ features: LogFeatures; category: string }> = [];
  private featureExtractors: Map<string, (log: LogData) => number | boolean | string> = new Map();
  private categoryStats: Map<string, { count: number; confidence: number[] }> = new Map();
  private retrainTimer?: NodeJS.Timeout;
  private isTraining: boolean = false;
  private patterns: Map<string, RegExp[]> = new Map();

  constructor(options: MLClassifierOptions = {}) {
    this.options = {
      enabled: true,
      modelType: 'pattern-matching',
      features: ['messageLength', 'levelNumeric', 'hasError', 'hasStructuredData'],
      categories: ['error', 'performance', 'security', 'business', 'system', 'debug'],
      trainingDataSize: 10000,
      retrainInterval: 3600000, // 1 hour
      confidenceThreshold: 0.6,
      onlineTraining: true,
      persistModel: false,
      modelPath: './@oxog-turbologger-model.json',
      ...options
    };

    if (this.options.enabled) {
      this.setupFeatureExtractors();
      this.initializePatterns();
      this.initializeModel();
      this.startRetraining();
    }
  }

  private initializePatterns(): void {
    // Error patterns
    this.patterns.set('error', [
      /\b(error|exception|fail|crash|panic|fatal|abort|terminated)\b/i,
      /\b(stack trace|backtrace|core dump)\b/i,
      /\b(http [45]\d{2}|status [45]\d{2})\b/i,
      /\b(timeout|connection refused|access denied)\b/i
    ]);

    // Performance patterns
    this.patterns.set('performance', [
      /\b(slow|performance|latency|response time|duration)\b/i,
      /\b(\d+ms|\d+s response|\d+\.\d+s)\b/i,
      /\b(memory usage|cpu usage|load average)\b/i,
      /\b(gc|garbage collect|heap|memory leak)\b/i
    ]);

    // Security patterns
    this.patterns.set('security', [
      /\b(auth|authentication|authorization|login|logout)\b/i,
      /\b(security|vulnerability|attack|intrusion)\b/i,
      /\b(ssl|tls|certificate|encryption)\b/i,
      /\b(firewall|blocked|suspicious|malicious)\b/i
    ]);

    // Business patterns
    this.patterns.set('business', [
      /\b(order|payment|transaction|purchase|billing)\b/i,
      /\b(user|customer|account|profile)\b/i,
      /\b(api|endpoint|service|request)\b/i,
      /\b(workflow|process|business logic)\b/i
    ]);

    // System patterns
    this.patterns.set('system', [
      /\b(startup|shutdown|restart|reload)\b/i,
      /\b(database|db|sql|query|connection)\b/i,
      /\b(file|disk|storage|backup)\b/i,
      /\b(network|tcp|udp|socket|port)\b/i
    ]);

    // Debug patterns
    this.patterns.set('debug', [
      /\b(debug|trace|verbose|detail)\b/i,
      /\b(variable|parameter|function|method)\b/i,
      /\b(step|iteration|loop|condition)\b/i
    ]);
  }

  private setupFeatureExtractors(): void {
    // Text analysis extractors
    this.featureExtractors.set('messageLength', (log): number => {
      const message = this.extractMessage(log);
      return message ? message.length : 0;
    });

    this.featureExtractors.set('wordCount', (log): number => {
      const message = this.extractMessage(log);
      return message ? message.split(/\s+/).length : 0;
    });

    this.featureExtractors.set('uppercaseRatio', (log): number => {
      const message = this.extractMessage(log);
      if (!message) return 0;
      const uppercase = message.match(/[A-Z]/g);
      return uppercase ? uppercase.length / message.length : 0;
    });

    this.featureExtractors.set('numbersCount', (log): number => {
      const message = this.extractMessage(log);
      if (!message) return 0;
      const numbers = message.match(/\d/g);
      return numbers ? numbers.length : 0;
    });

    this.featureExtractors.set('specialCharsCount', (log): number => {
      const message = this.extractMessage(log);
      if (!message) return 0;
      const special = message.match(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/g);
      return special ? special.length : 0;
    });

    // Content pattern extractors
    this.featureExtractors.set('hasError', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\b(error|exception|fail|crash|panic|fatal)\b/i, message || '');
    });

    this.featureExtractors.set('hasWarning', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\b(warn|warning|deprecated|timeout|retry)\b/i, message || '');
    });

    this.featureExtractors.set('hasIpAddress', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\b(?:\d{1,3}\.){3}\d{1,3}\b/, message || '');
    });

    this.featureExtractors.set('hasEmail', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, message || '');
    });

    this.featureExtractors.set('hasUrl', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/https?:\/\/[^\s]+/, message || '');
    });

    this.featureExtractors.set('hasPath', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\/[^\s]*|[A-Z]:\\[^\s]*/, message || '');
    });

    this.featureExtractors.set('hasTimestamp', (log): boolean => {
      return !!(log.time || (log as any).timestamp || (log as any).ts);
    });

    // Structural extractors
    this.featureExtractors.set('levelNumeric', (log): number => {
      const level = String(log.level || log.levelLabel || 'info');
      const levelMap: Record<string, number> = {
        'trace': 10, 'debug': 20, 'info': 30, 'warn': 40, 'error': 50, 'fatal': 60
      };
      return levelMap[level.toLowerCase()] || 30;
    });

    this.featureExtractors.set('hasStructuredData', (log): boolean => {
      const excluded = ['msg', 'message', 'level', 'levelLabel', 'time', 'timestamp'];
      return Object.keys(log).some(key => !excluded.includes(key) && typeof log[key] === 'object');
    });

    this.featureExtractors.set('fieldsCount', (log): number => {
      return Object.keys(log).length;
    });

    // Performance extractors
    this.featureExtractors.set('hasResponseTime', (log): boolean => {
      return !!(log.responseTime || (log as any).duration || (log as any).latency);
    });

    this.featureExtractors.set('hasStatusCode', (log): boolean => {
      return !!(log.statusCode || (log as any).status || (log as any).code);
    });

    this.featureExtractors.set('hasMemoryInfo', (log): boolean => {
      return !!((log as any).memory || (log as any).heap || (log as any).rss);
    });

    this.featureExtractors.set('hasCpuInfo', (log): boolean => {
      return !!((log as any).cpu || (log as any).load);
    });

    // Security extractors
    this.featureExtractors.set('hasSensitiveData', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\b(password|token|key|secret|auth|credential)\b/i, message || '');
    });

    this.featureExtractors.set('hasAuthData', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\b(login|logout|auth|session|jwt|bearer)\b/i, message || '');
    });

    this.featureExtractors.set('hasFailedAuth', (log): boolean => {
      const message = this.extractMessage(log);
      return this.safeRegexTest(/\b(unauthorized|forbidden|access denied|invalid credentials)\b/i, message || '');
    });
  }

  private initializeModel(): void {
    this.model = {
      categories: new Map(),
      totalSamples: 0
    };

    // Initialize categories
    for (const category of this.options.categories) {
      this.model.categories.set(category, {
        count: 0,
        features: new Map(),
        patterns: this.patterns.get(category) || []
      });
    }
  }

  private extractMessage(log: LogData): string {
    return String(log.msg || log.message || '');
  }

  private safeRegexTest(regex: RegExp, text: string): boolean {
    // BUG-053 ANALYSIS: RegExp patterns are already optimally cached
    // Patterns are compiled once in initializePatterns() and stored in this.patterns Map
    // This method reuses pre-compiled patterns, no recompilation occurs
    try {
      return regex.test(text);
    } catch {
      return false;
    }
  }

  private extractFeatures(log: LogData): LogFeatures {
    const features: Partial<LogFeatures> = {};

    // Extract all configured features
    for (const featureName of this.options.features) {
      const extractor = this.featureExtractors.get(featureName);
      if (extractor) {
        try {
          const extracted = extractor(log);

          // BUG-025 FIX: Validate extractor return type before assigning
          // Extractors should return number, string, or boolean for ML features
          if (typeof extracted === 'number' ||
              typeof extracted === 'string' ||
              typeof extracted === 'boolean') {
            features[featureName] = extracted;
          } else if (extracted !== null && extracted !== undefined) {
            // Attempt to coerce to number if possible
            const coerced = Number(extracted);
            if (!isNaN(coerced)) {
              features[featureName] = coerced;
            }
            // Otherwise skip invalid feature value
          }
        } catch {
          // Skip failed extractions
        }
      }
    }

    // Add temporal features
    const now = new Date(log.time || Date.now());
    features.hour = now.getHours();
    features.dayOfWeek = now.getDay();
    features.isWeekend = features.dayOfWeek === 0 || features.dayOfWeek === 6;

    // Calculate nesting depth
    features.nestingDepth = this.calculateNestingDepth(log);

    return features as LogFeatures;
  }

  private calculateNestingDepth(obj: unknown, depth = 0): number {
    if (depth > 10) return depth; // Prevent infinite recursion
    
    if (typeof obj === 'object' && obj !== null) {
      let maxDepth = depth;
      for (const value of Object.values(obj)) {
        if (typeof value === 'object' && value !== null) {
          maxDepth = Math.max(maxDepth, this.calculateNestingDepth(value, depth + 1));
        }
      }
      return maxDepth;
    }
    
    return depth;
  }

  classify(log: LogData): ClassificationResult | null {
    if (!this.options.enabled || !this.model) {
      return null;
    }

    const features = this.extractFeatures(log);
    const scores = new Map<string, number>();

    // Pattern-based classification
    for (const [category, categoryModel] of this.model.categories) {
      let score = 0;
      let patternMatches = 0;

      // Check patterns
      const message = this.extractMessage(log);
      for (const pattern of categoryModel.patterns) {
        if (this.safeRegexTest(pattern, message)) {
          patternMatches++;
        }
      }

      // Pattern score (0-0.7)
      if (categoryModel.patterns.length > 0) {
        score += (patternMatches / categoryModel.patterns.length) * 0.7;
      }

      // Feature-based scoring (0-0.3)
      if (categoryModel.count > 0) {
        let featureScore = 0;
        let featureCount = 0;

        for (const [featureName, featureValue] of Object.entries(features)) {
          const featureStats = categoryModel.features.get(featureName);
          if (featureStats && featureStats.count > 0) {
            if (typeof featureValue === 'boolean') {
              // Boolean features: check if matches expected value
              const expectedValue = featureStats.mean > 0.5;
              if (featureValue === expectedValue) {
                featureScore += 1;
              }
            } else if (typeof featureValue === 'number') {
              // Numeric features: distance from mean
              const distance = Math.abs(Number(featureValue) - featureStats.mean);
              const range = featureStats.max - featureStats.min;
              if (range > 0) {
                featureScore += Math.max(0, 1 - (distance / range));
              }
            }
            featureCount++;
          }
        }

        if (featureCount > 0) {
          score += (featureScore / featureCount) * 0.3;
        }
      }

      // Prior probability adjustment
      if (this.model.totalSamples > 0) {
        const prior = categoryModel.count / this.model.totalSamples;
        score = score * 0.8 + prior * 0.2;
      }

      scores.set(category, score);
    }

    // Find best category
    let bestCategory = '';
    let bestScore = 0;
    let alternatives: Array<{ category: string; confidence: number }> = [];

    for (const [category, score] of scores) {
      if (score > bestScore) {
        if (bestCategory) {
          alternatives.push({ category: bestCategory, confidence: bestScore });
        }
        bestCategory = category;
        bestScore = score;
      } else if (score > 0) {
        alternatives.push({ category, confidence: score });
      }
    }

    // Check confidence threshold
    if (bestScore < this.options.confidenceThreshold) {
      bestCategory = 'unknown';
      bestScore = 0.5;
    }

    // Sort alternatives by confidence
    alternatives.sort((a, b) => b.confidence - a.confidence);
    alternatives = alternatives.slice(0, 3); // Keep top 3

    return {
      category: bestCategory,
      confidence: bestScore,
      features,
      alternatives: alternatives.length > 0 ? alternatives : undefined
    };
  }

  train(log: LogData, category: string): void {
    if (!this.options.enabled || !this.model || !this.options.onlineTraining) {
      return;
    }

    const features = this.extractFeatures(log);
    
    // Add to training data
    this.trainingData.push({ features, category });
    
    // Limit training data size
    if (this.trainingData.length > this.options.trainingDataSize) {
      this.trainingData.shift();
    }

    // Update model
    const categoryModel = this.model.categories.get(category);
    if (categoryModel) {
      categoryModel.count++;
      this.model.totalSamples++;

      // Update feature statistics
      for (const [featureName, featureValue] of Object.entries(features)) {
        if (!categoryModel.features.has(featureName)) {
          categoryModel.features.set(featureName, {
            sum: 0,
            count: 0,
            min: Number.MAX_VALUE,
            max: Number.MIN_VALUE,
            mean: 0
          });
        }

        const stats = categoryModel.features.get(featureName)!;
        const numValue = typeof featureValue === 'boolean' ? (featureValue ? 1 : 0) : Number(featureValue);
        
        if (!isNaN(numValue)) {
          stats.sum += numValue;
          stats.count++;
          stats.min = Math.min(stats.min, numValue);
          stats.max = Math.max(stats.max, numValue);
          stats.mean = stats.sum / stats.count;
        }
      }
    }
  }

  private startRetraining(): void {
    if (this.options.retrainInterval > 0) {
      this.retrainTimer = setInterval(() => {
        this.retrain();
      }, this.options.retrainInterval);
    }
  }

  private retrain(): void {
    if (this.isTraining || !this.model || this.trainingData.length < 10) {
      return;
    }

    this.isTraining = true;

    try {
      // Reset model
      this.initializeModel();

      // Retrain on all data
      for (const sample of this.trainingData) {
        const categoryModel = this.model.categories.get(sample.category);
        if (categoryModel) {
          categoryModel.count++;
          this.model.totalSamples++;

          // Update feature statistics
          for (const [featureName, featureValue] of Object.entries(sample.features)) {
            if (!categoryModel.features.has(featureName)) {
              categoryModel.features.set(featureName, {
                sum: 0,
                count: 0,
                min: Number.MAX_VALUE,
                max: Number.MIN_VALUE,
                mean: 0
              });
            }

            const stats = categoryModel.features.get(featureName)!;
            const numValue = typeof featureValue === 'boolean' ? (featureValue ? 1 : 0) : Number(featureValue);
            
            if (!isNaN(numValue)) {
              stats.sum += numValue;
              stats.count++;
              stats.min = Math.min(stats.min, numValue);
              stats.max = Math.max(stats.max, numValue);
              stats.mean = stats.sum / stats.count;
            }
          }
        }
      }
    } finally {
      this.isTraining = false;
    }
  }

  getStats(): {
    totalSamples: number;
    categories: Record<string, { count: number; confidence: number }>;
    isTraining: boolean;
  } {
    const categories: Record<string, { count: number; confidence: number }> = {};
    
    if (this.model) {
      for (const [name, model] of this.model.categories) {
        const stats = this.categoryStats.get(name);
        const avgConfidence = stats && stats.confidence.length > 0 
          ? stats.confidence.reduce((a, b) => a + b, 0) / stats.confidence.length 
          : 0;
        
        categories[name] = {
          count: model.count,
          confidence: avgConfidence
        };
      }
    }

    return {
      totalSamples: this.model?.totalSamples || 0,
      categories,
      isTraining: this.isTraining
    };
  }

  destroy(): void {
    if (this.retrainTimer) {
      clearInterval(this.retrainTimer);
      this.retrainTimer = undefined;
    }
    
    this.model = null;
    this.trainingData = [];
    this.featureExtractors.clear();
    this.categoryStats.clear();
    this.patterns.clear();
  }
}