/**
 * Module dependencies.
 */

var express = require('express')
  , RedisStore = require('connect-redis')(express)
  , Twitter = require('./twitter')
  , connect = require('connect')
  , routes = require('./routes')
  , http = require('http')
  , path = require('path')
  , socket = require('socket.io')
  , redis = require('redis')
  , app = express();
  
var cookieParser = express.cookieParser('your secret')
  , sessionStore = new connect.middleware.session.MemoryStore();
var consumerKey = 'ACc6vs7VOl39LaGTym4ybw',
    consumerSecret = 'LnC3eUkYCpLXEqJZalKidKHBFQthG7WbmHWT0dTWY';
    
app.configure(function () {
  app.set('port', process.env.PORT || 3000);
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.favicon());
  app.use(express.logger('dev'));
  app.use(express.bodyParser());
  app.use(express.methodOverride());
  app.use(cookieParser);
  app.use(express.session({ store: sessionStore }));
  app.use(require('less-middleware')({ src: __dirname + '/public' }));
  app.use(app.router);
  app.use(express.static(path.join(__dirname, 'public')));
});

// development only
app.configure('development', function(){
  express.logger('development node');
  app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
});

app.configure('production', function(){
  express.logger('production node');
  app.use(express.errorHandler()); 
});

var server =  app.listen(app.get('port')) // http.createServer(app)
  , io = require('socket.io').listen(server);

var SessionSockets = require('session.socket.io')
  , sessionSockets = new SessionSockets(io, sessionStore, cookieParser);

// https://devcenter.heroku.com/articles/using-socket-io-with-node-js-on-heroku
io.configure(function () { 
  io.set("transports", ["xhr-polling"]); 
  io.set("polling duration", 10); 
});

// Handlers
function main(req, res) {
  res.sendfile(__dirname + '/index.html');
}

function game(req, res) {
  var jadeFile = 'game.jade',
    loginMessage = 'Home',
    loginTo = '/logout',
    screenName = 'Anyone';
  
  if (req.session && req.session.oauth) {
    try{
      screenName = req.session.oauth._results.screen_name; // undefined error
      console.log('/game > screanName = ' + screenName);
    }catch(e){
      console.error('/game > screen_name ERROR: ' + e);
      setTimeout(res.redirect, 500, '/');
    }
  }
  
  res.render(jadeFile, {
    title: 'LastBrownie',
    loginm: loginMessage,
    loginto: loginTo,
    screen_name: screenName
  });
}

// Routes Home
app.get('/', main);
app.get('/home', main);

// Routes Game
app.get('/game', game);

app.get('/login', function(req, res){
  var tw = new Twitter(consumerKey, consumerSecret);
  tw.getRequestToken(function(error, url){
    if(error){
      req.session.destroy(function(){
        console.error(error);
        res.writeHead(500, {'Content-Type': 'text/html'});
        res.send('ERROR :' + error);
      });
    }else{
      req.session.oauth = tw;
      res.redirect(url);
    }
  });
});

app.get('/logout', function(req, res){
  req.session.destroy(function(){
    res.redirect('/');
  });
});

// authorized callback from twitter.com
app.get('/authorized', function(req, res, next){
  if (req.session.oauth) {
    var tw = new Twitter(consumerKey, consumerSecret, req.session.oauth);
    tw.getAccessToken(req.query.oauth_verifier, function(error){
      if(error){
        req.session.destroy(function(){
          console.error(error);
          res.send(error);
        });
      }else{
        req.session.oauth = tw;
        console.log('/authorized > user_id = ' + tw._results.user_id);
        res.redirect('/game');
      }
    });
  }
  else {
    res.redirect('/login'); // Redirect to login page
  }
});

io.set('authorization', function (data, accept){
  if(data.headers.cookie){
    console.log('/authorization > ' + data.headers.cookie);
  } else {
    console.log('/authorization > No cookie transmitted');
  }
});

io.sockets.tid2clt = {};
io.sockets.broadcastTo = function(to, message){ //to has to be an Array
  try{
    for(var i=to.length; i--;){
      var clt = this.tid2clt[to[i]];
      if(clt){
        if(this.flags.json){
          clt.json.send(message);
        }else{
          clt.send(message);
        }
      }
    }
  }catch(e){
    console.error('broadcastTo ERROR: '+e);
  }
  return this;
};

var count = 0,
    maxcount = 0;
    

sessionSockets.on('connection', function (err, socket, session) {
  count++;
  // console.log('/connection > count = '+count);
  socket.json.broadcast.send({count: count});
  socket.json.send({count: count});
  if(count>maxcount){
    console.log('maxcount: '+(maxcount=count));
  }
  
  var sessionID = socket.id;
  console.log('/connection > A socket with sessionID '+sessionID+' connected!');
  // setup an inteval that will keep our session fresh

  if(session && session.oauth){
    console.log('/connection > get user id from session oauth');
    session.save(); // ???
    var tw = new Twitter(consumerKey, consumerSecret, session.oauth);
    try{
      io.sockets.tid2clt[tw._results.user_id] = socket;
    }catch(e){
      console.error('io.sockets.tid2sid ERROR: ' + e);
    }
    
    //view home timeline
    var scroll = function(params){
      tw.getTimeline(params, function(error, data, response){
        if(error){
          console.error('TIMELLINE ERROR: ' + error);
        }else{
          socket.json.send(data);
          //req.session.page.push(data);
        }
      });
    };
    scroll({page: 1, include_entities: true});
    //manage followers
    if(!socket.followers){
      tw.followers(function(error, data, response){
        if(error){
          console.error('FOLLOWERS ERROR: ' + error);
        }else{
          socket.followers = data;
        }
      });
    }
    
    //user streams
    var usParams = {include_entities: true},
        stream = tw.openUserStream(usParams);
    stream.on('data', function(data){
      try{
        if(data.friends){
        }else{
          socket.json.send(data);
        }
      }catch(e){
        console.error('dispatch event ERROR: ' + e);
      }
    });
    
    stream.on('error', function(err){
      session.destroy(function(){
        console.error('UserStream ERROR: ' + err);
      });
    });
    
    stream.on('end', function(){
      session.destroy(function(){
        console.log('UserStream ends successfully');
      });
    });
  } else {
    console.log('/connection > No session oauth');
  }

  socket.on('update', function(message){
    tw.update(message, function(error, data, response){
      if(error){
        console.error("UPDATE ERROR\ndata: "+data+'response: '+response+'oauth: '+tw+'message: '+message);
      }else{
        socket.json.send(data);
        io.sockets.json.broadcastTo(socket.followers, data);
      }
    });
  });
  
  socket.on('retweet', function(message){
    tw.retweet(message.id_str, function(error, data, response){
      if(error){
        console.error("RETWEET ERROR\ndata: "+data+'response: '+response+'oauth: '+tw+'message: '+message);
      }else{
        socket.json.send(data);
        io.sockets.json.broadcastTo(socket.followers, data);
      }
    });
  });
  
  socket.on('destroy', function(message){
    tw.destroy(message.id_str, function(error, data, response){
      if(error){
        console.error("DELETE ERROR\ndata: "+data+'response: '+response+'oauth: '+tw+'message: '+message);
      }
    });
  });
  
  socket.on('scroll', function(message){
    scroll(message);
  });
  
  // Based on http://www.danielbaulig.de/socket-ioexpress/
  var intervalID = setInterval(function(){
      // reload the session (just in case something changed,
      // we don't want to override anything, but the age)
      // reloading will also ensure we keep an up2date copy
      // of the session with our connection.
      session.reload(function(){ 
          // "touch" it (resetting maxAge and lastAccess)
          // and save it back again.
          session.touch().save();
      });
  }, 60*1000);
  
  socket.on('disconnect', function(){
    count--;
    socket.json.broadcast.send({count: count});
  
    console.log('/disconnect > A socket with sessionID '+sessionID+' disconnected!');
    // clear the socket interval to stop refreshing the session
    clearInterval(intervalID);
  });
});

server.listen(app.get('port'));
console.log('Express server listening on port ' + app.get('port'));
