# Tutorial 2: New York Times RSS Feed 

In this tutorial, you will create a New York Times device in Thingpedia.
It allows users to retrieve articles from New York Times front page, and get notified when 
there is a new article published.
A developer account is required to create the device. 
You can request to become a developer from [here](/user/request-developer). 

## Step 1: set up your device
Go to the [Device Creation Page](/thingpedia/upload/create), fill in the following basic information 
about the device:

- ID: `<your-name>.nytimes` (Each device in Thingpedia needs an unique ID, so use your name or email address 
in the device name to make sure it won't conflict with others)
- Name: `My New York Times` (It would be good to have a unique name so your device is easier to identify)
- Description: `My New York Times RSS Feed`
- Category: `Media`
- Icon: choose a PNG file you like (512x512 resolution is recommended)
- JS code: leave it empty

## Step 2: describe what your device does
Click on `manifest.tt` on the left panel. 
Copy the following code to the editor and replace `<your-name>.nytimes` with the 
actual device ID:
```tt
class @<your-name>.nytimes {
  // tell almond it is an rss feed device
  import loader from @org.thingpedia.rss(); 

  /* 
    The function to return the articles from the front page.
    Example commands: "get articles from New York Times front page"
    Qualifiers: 
      - monitorable: if you want the query to be monitored and trigger actions on change
      - list: if the query returns multiple results  
  */
  monitorable list query get_front_page(out title: String,
                                        out link: Entity(tt:url),
                                        out updated: Date,
                                        out description: String)
  // confirmation sentence which will be prompted to the users before execution:
  #_[confirmation="New York Times articles"] 
  // the format of how the output will be presented to the users: 
  #_[formatted=[{type="rdl",webCallback="${link}",displayTitle="${title}",displayText="${description}"}]] 
  // if the query is monitored, how frequent we invoke it
  #[poll_interval=60min] 
  #[doc="read the front page of the New York Times"]
  // the URL of the RSS feed
  #[url="http://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml"];
}
```

## Step 3: provide some natural language examples
Click on `dataset.tt` on the left panel. 
Copy the following code to the editor and replace `<your-name>.nytimes` with the 
actual device ID:
```tt
dataset @<your-name>.nytimes {
  // the "utterances" annotation specifies different ways to express the command
  query  := @<your-name>.nytimes.get_front_page()
  #_[utterances=["new york times","the front page of the new york times","articles in the new york times"]];
    
  // filters can be applied to get partial results
  query  := (@<your-name>.nytimes.get_front_page()), updated >= start_of(day)
  #_[utterances=["today 's articles in the new york times"]];
    
  // a query can be monitored to form a stream, which notifies users when there is a change
  stream  := monitor (@<your-name>.nytimes.get_front_page())
  #_[utterances=["when the new york times publishes a new article"]];
}
```

## Step 4: submit the device
Click the `Create` button at the top left corner to submit the device. 
Congratulations! You made a New York Times device for Thingpedia. 
Go to [Thingpedia page](/thingpedia) and search for your device name to see your device.

## Try your device
Please give Almond around 5 minutes to digest the device you just created.
A banner will tell you the status on the top of the page. 
Once the banner disappears,
you can go to [My Almond](/me), then type in `get New York Times` to get the latest news!

Note that at this point, the natural language support is very limited. 
If you want to train the full model, click on the `Start training` button at the bottom 
of the details page of your device to start a new training job. The training will take up to 12 hours.
